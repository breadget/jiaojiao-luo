import {
  analyzeMessage,
  buildAgentReply,
  type AgentAnalysis,
} from '@/lib/server/agent-brain';
import { isLlmReasoningEffort } from '@/lib/llm/providers';
import {
  buildWorkflowSystemPrompt,
  callChatModel,
  resolveLlmSelection,
  type ChatMessage,
} from '@/lib/server/llm';
import {
  ConsumerSessionError,
  consumerSessionErrorResponse,
  getConsumerSession,
  getConsumerMessage,
  type ConsumerSession,
} from '@/lib/server/consumer-store';
import { persistChatRunReply } from '@/lib/server/consumer-chat';
import {
  composeContextualMessage,
  loadConversationHistory,
  type ConversationHistoryOptions,
} from '@/lib/server/conversation-history';
import { callN8nWorkflow } from '@/lib/server/n8n';
import { buildRequest, extractMessage } from '@/lib/server/protocol';
import {
  claimRunRequest,
  decideReplay,
  isSafeRequestId,
  releaseClaim,
  replayNotice,
  waitForSettledRun,
} from '@/lib/server/replay';
import {
  createChatRun,
  createN8nRun,
  getRunByRequestId,
  getWorkflowById,
} from '@/lib/server/workflow-store';
import type { ChatMode, RunMode, WorkflowRun } from '@/lib/workflow-types';
import {
  enforceExecutionAccess,
  enforceRateLimit,
  readJsonObject,
} from '@/lib/server/security';

function readOptionalString(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, limit);
}

/** 从模型回复里读出它自己汇报的优先级，用于运行记录。 */
function parsePriority(text: string): '高' | '中' | '低' | null {
  const matched = text.match(/优先级\s*[=:：]\s*(高|中|低)/);
  return matched ? (matched[1] as '高' | '中' | '低') : null;
}

function requestIdError(): Response {
  return Response.json(
    {
      error:
        'requestId 格式非法：只允许 8–80 位的字母、数字、点、下划线、冒号、连字符。',
    },
    { status: 400 },
  );
}

function inProgressError(requestId: string): Response {
  return Response.json(
    {
      error:
        '该 requestId 正在执行中，本次未重复触发。请稍后用同一 requestId 重试以获取结果。',
      code: 'REQUEST_IN_PROGRESS',
      requestId,
    },
    { status: 409, headers: { 'Retry-After': '2' } },
  );
}

function modesFromRun(run: WorkflowRun): {
  mode: ChatMode;
  executionMode: RunMode;
  degraded: boolean;
} {
  const mode: ChatMode =
    run.engine === 'n8n'
      ? 'n8n'
      : run.engine === 'model'
        ? 'model'
        : 'simulated';
  const executionMode: RunMode =
    run.mode ??
    (run.engine === 'model'
      ? 'llm'
      : run.engine === 'simulated'
        ? 'simulated'
        : 'rules');
  return {
    mode,
    executionMode,
    degraded: run.degraded ?? executionMode === 'simulated',
  };
}

/** 已落库运行的重放必须保留原始 engine/mode/degraded 和失败语义。 */
function replayResponse(run: WorkflowRun, analysis: AgentAnalysis): Response {
  const failed = run.status === 'failed';
  const payload = {
    ...(failed
      ? { error: run.errorMessage ?? run.output.result ?? '执行失败。' }
      : {}),
    reply: run.output.result,
    intent: analysis.intent,
    priority: analysis.priority,
    keywords: analysis.keywords,
    run,
    ...modesFromRun(run),
    requestId: run.requestId ?? null,
    sessionId: run.sessionId ?? null,
    errorCode: run.errorCode ?? null,
    replayed: true,
    notice: replayNotice(run),
  };
  return Response.json(payload, { status: failed ? 502 : 200 });
}

export async function POST(request: Request) {
  const accessError = enforceExecutionAccess(request);
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'agent-chat',
    limit: 12,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body;

  if (typeof body.workflowId !== 'string' || !body.workflowId) {
    return Response.json({ error: '缺少工作流编号。' }, { status: 400 });
  }
  if (typeof body.message !== 'string' || !body.message.trim()) {
    return Response.json({ error: '消息内容不能为空。' }, { status: 400 });
  }
  if (body.message.length > 2000) {
    return Response.json(
      { error: '消息过长，请控制在 2000 字以内。' },
      { status: 400 },
    );
  }

  const workflow = await getWorkflowById(body.workflowId);
  if (!workflow?.publishedSteps) {
    return Response.json(
      { error: '当前没有已发布的工作流版本，请先在创建端发布。' },
      { status: 409 },
    );
  }

  const message = body.message.trim();
  const analysis = analyzeMessage(message);

  // 在浏览器会话授权后读取完整记录；读取失败不能退化成只发送当前一句。
  const consumerSessionId = readOptionalString(body.consumerSessionId, 80);
  const agentMessageId = readOptionalString(body.agentMessageId, 80);
  if (agentMessageId && !consumerSessionId) {
    return Response.json({ error: '回复消息缺少所属对话。' }, { status: 400 });
  }
  let consumerSession: ConsumerSession | null = null;
  const historyOptions: ConversationHistoryOptions = {
    currentMessageId: readOptionalString(body.userMessageId, 80),
    currentText: message,
  };
  let conversationHistory: ChatMessage[] = [];
  try {
    if (consumerSessionId) {
      consumerSession = await getConsumerSession(
        request,
        workflow.id,
        consumerSessionId,
      );
      if (!consumerSession) {
        throw new ConsumerSessionError(
          '这条对话不存在或不属于当前浏览器。',
          404,
        );
      }
      if (agentMessageId) {
        const agentMessage = await getConsumerMessage(
          consumerSession.id,
          agentMessageId,
        );
        if (!agentMessage || agentMessage.role !== 'agent') {
          throw new ConsumerSessionError('回复消息未保存在当前对话中。', 409);
        }
        const linkedRequestId = agentMessage.metadata.chatRequestId;
        if (linkedRequestId && linkedRequestId !== body.requestId) {
          throw new ConsumerSessionError('回复消息与当前请求不匹配。', 409);
        }
      }
      conversationHistory = await loadConversationHistory(
        consumerSession.id,
        historyOptions,
      );
    }
  } catch (cause) {
    return consumerSessionErrorResponse(cause);
  }
  const chatResponse = async (
    payload: Record<string, unknown>,
    status = 200,
  ) => {
    if (consumerSession && agentMessageId && payload.run) {
      await persistChatRunReply(
        consumerSession,
        agentMessageId,
        payload.run as WorkflowRun,
        {
          intent: analysis.intent,
          priority: analysis.priority,
        },
      );
    }
    return Response.json(payload, { status });
  };
  const chatReplayResponse = async (run: WorkflowRun) => {
    const response = replayResponse(run, analysis);
    return chatResponse(
      (await response.json()) as Record<string, unknown>,
      response.status,
    );
  };
  // n8n 侧的提示词节点只读 message（归一后是 question），看不到 context，
  // 也不一定挂了 Memory 节点：把历史拼进 message，任何绑定的工作流都能接上。
  // 站点自己的运行记录仍然保存用户原话（见下面的 createN8nRun）。
  const n8nMessage = composeContextualMessage(message, conversationHistory);

  // 使用端在界面上自带的模型配置；服务端只透传，不落盘。
  // provider 决定用哪家 API（以及默认端点/默认模型），Key 永远是用户自带的。
  const apiKey = readOptionalString(body.apiKey, 400);
  const provider = readOptionalString(body.provider, 40);
  const requestedBaseUrl = readOptionalString(body.baseUrl, 400);
  const requestedModel = readOptionalString(body.model, 120);
  const reasoningEffort =
    body.reasoningEffort === undefined
      ? 'auto'
      : isLlmReasoningEffort(body.reasoningEffort)
        ? body.reasoningEffort
        : null;
  if (!reasoningEffort) {
    return Response.json(
      { error: '推理强度只能是 auto、low、medium 或 high。' },
      { status: 400 },
    );
  }
  const selection = resolveLlmSelection({
    provider,
    baseUrl: requestedBaseUrl,
    model: requestedModel,
  });
  if (!selection.ok) {
    return Response.json(
      { error: selection.error, errorCode: selection.code },
      { status: 400 },
    );
  }
  const baseUrl = selection.selection.baseUrl;
  const model = selection.selection.model;
  const incomingRequestId = readOptionalString(body.requestId, 80);
  const incomingSessionId = readOptionalString(body.sessionId, 80);
  if (incomingRequestId && !isSafeRequestId(incomingRequestId)) {
    return requestIdError();
  }

  // ── 分支一：工作流绑定了 n8n webhook → 一切交给真实引擎 ──
  // 关键点：模型 Key 不是存在 n8n 里，而是随请求透传给 n8n（BYO Key）。
  if (workflow.n8nWebhookUrl) {
    // 幂等三连：格式校验 → 重放已完成的 → 抢执行权（抢不到就等，绝不重复跑）
    const decision = decideReplay(
      incomingRequestId ? await getRunByRequestId(incomingRequestId) : null,
      workflow.id,
      incomingSessionId,
    );
    if (decision.kind === 'conflict') {
      return Response.json({ error: decision.message }, { status: 409 });
    }
    if (decision.kind === 'replay') {
      return chatReplayResponse(decision.run);
    }

    let claimedRunId: string | null = null;
    if (incomingRequestId) {
      const claim = await claimRunRequest(incomingRequestId);
      if (claim.kind === 'in_progress') {
        const settled = await waitForSettledRun(incomingRequestId);
        if (!settled) return inProgressError(incomingRequestId);
        const settledDecision = decideReplay(
          settled,
          workflow.id,
          incomingSessionId,
        );
        if (settledDecision.kind === 'conflict') {
          return Response.json(
            { error: settledDecision.message },
            { status: 409 },
          );
        }
        return chatReplayResponse(settled);
      }
      claimedRunId = claim.runId;
    }

    const startedAt = Date.now();
    const envelopeRequest = buildRequest({
      workflowId: workflow.id,
      message: n8nMessage ?? message,
      requestId: incomingRequestId ?? null,
      sessionId: incomingSessionId ?? null,
      userId: readOptionalString(body.userId, 80) ?? null,
      llm: apiKey ? { apiKey, baseUrl, model, reasoningEffort } : null,
      context: {
        intentHint: analysis.intent,
        // 原始输入始终单独保留一份：工作流需要干净文本时用它，
        // 运行记录和页面显示的也仍然是这句原话。
        currentMessage: message,
        // n8n 侧的 Memory 只覆盖它自己跑过的轮次；把站点已落库的历史一并带上，
        // 让绑定 n8n 的工作流也能看到同一个会话的前文。
        ...(conversationHistory.length ? { conversationHistory } : {}),
      },
      source: 'urtoris-web',
      workflowVersion: workflow.version,
      workflowName: workflow.name,
      steps: workflow.publishedSteps.map((step, index) => ({
        index: index + 1,
        id: step.id,
        title: step.title,
        detail: step.detail,
        kind: step.kind,
      })),
    });

    try {
      const result = await callN8nWorkflow({
        webhookUrl: workflow.n8nWebhookUrl,
        request: envelopeRequest,
      });
      const envelope = result.envelope;

      const run = await createN8nRun(workflow, envelope, {
        message,
        startedAt,
        sessionId: envelopeRequest.sessionId,
        runId: claimedRunId ?? undefined,
      });

      if (!envelope.success) {
        // 失败必须如实暴露：带上错误码、requestId 和这次运行的记录。
        const code = envelope.error?.code ?? 'INTERNAL_ERROR';
        return chatResponse(
          {
            error: `[${code}] ${envelope.error?.message ?? 'n8n 执行失败'}`,
            errorCode: code,
            mode: 'n8n' satisfies ChatMode,
            executionMode: envelope.mode,
            degraded: envelope.degraded,
            requestId: envelope.requestId,
            sessionId: envelopeRequest.sessionId,
            run,
            envelope,
          },
          502,
        );
      }

      const reply =
        extractMessage(envelope.data) ??
        `「${workflow.name}」已在 n8n 上执行完成。`;

      return chatResponse({
        reply,
        intent: analysis.intent,
        priority: analysis.priority,
        keywords: analysis.keywords,
        run,
        mode: 'n8n' satisfies ChatMode,
        executionMode: envelope.mode,
        degraded: envelope.degraded,
        requestId: envelope.requestId,
        sessionId: envelopeRequest.sessionId,
        errorCode: null,
        envelope,
      });
    } finally {
      // 执行结束后释放 claim：此后靠 runs.request_id 唯一索引继续去重，
      // claim 表不会随时间无限增长。
      if (incomingRequestId) {
        try {
          await releaseClaim(incomingRequestId);
        } catch {
          // 释放失败只影响一次重试要等 TTL，不影响本次结果
        }
      }
    }
  }

  // ── 分支二：未绑定 n8n → 沿用使用端自带的模型 / 内置模拟器 ──
  const directDecision = decideReplay(
    incomingRequestId ? await getRunByRequestId(incomingRequestId) : null,
    workflow.id,
    incomingSessionId,
  );
  if (directDecision.kind === 'conflict') {
    return Response.json({ error: directDecision.message }, { status: 409 });
  }
  if (directDecision.kind === 'replay') {
    return chatReplayResponse(directDecision.run);
  }

  let claimedRunId: string | null = null;
  if (incomingRequestId) {
    const claim = await claimRunRequest(incomingRequestId);
    if (claim.kind === 'in_progress') {
      const settled = await waitForSettledRun(incomingRequestId);
      if (!settled) return inProgressError(incomingRequestId);
      const settledDecision = decideReplay(
        settled,
        workflow.id,
        incomingSessionId,
      );
      if (settledDecision.kind === 'conflict') {
        return Response.json(
          { error: settledDecision.message },
          { status: 409 },
        );
      }
      return chatReplayResponse(settled);
    }
    claimedRunId = claim.runId;
  }

  try {
    // 直连模型没有 n8n 信封，但仍使用同一个生成器来统一 request/session 语义。
    // 这个对象不包含 Key，也不会被落库。
    const directRequest = buildRequest({
      workflowId: workflow.id,
      message,
      requestId: incomingRequestId ?? null,
      sessionId: incomingSessionId ?? null,
      userId: readOptionalString(body.userId, 80) ?? null,
      context: { intentHint: analysis.intent },
      source: 'urtoris-web',
      workflowVersion: workflow.version,
    });
    const startedAt = Date.now();
    let reply: string;
    let mode: ChatMode;
    let usedModel: string | undefined;

    // 本机模型（Ollama）这类服务不需要 Key：只要服务本身允许免 Key，就照样真调模型。
    const shouldCallModel = Boolean(apiKey) || !selection.selection.keyRequired;
    if (shouldCallModel) {
      const history: ChatMessage[] = [
        {
          role: 'system',
          content: buildWorkflowSystemPrompt(workflow, {
            hasConversationHistory: conversationHistory.length > 0,
          }),
        },
        ...conversationHistory,
        { role: 'user', content: message },
      ];
      const result = await callChatModel({
        apiKey: apiKey ?? '',
        provider: selection.selection.providerId,
        baseUrl,
        model,
        reasoningEffort,
        messages: history,
      });

      if (!result.ok) {
        // 用户主动提供了 Key，失败时不降级、不伪装成功，且失败记录也参与幂等重放。
        const run = await createChatRun(workflow, message, analysis, {
          reply: result.error,
          engine: 'model',
          model,
          runId: claimedRunId ?? undefined,
          trace: {
            requestId: directRequest.requestId,
            sessionId: directRequest.sessionId,
            errorCode: result.code,
            errorMessage: result.error,
            durationMs: Date.now() - startedAt,
            attempts: 1,
            mode: 'llm',
            degraded: false,
          },
        });
        return chatResponse(
          {
            error: result.error,
            errorCode: result.code,
            mode: 'model' satisfies ChatMode,
            executionMode: 'llm' satisfies RunMode,
            degraded: false,
            provider: selection.selection.providerId,
            providerLabel: selection.selection.providerLabel,
            requestId: directRequest.requestId,
            sessionId: directRequest.sessionId,
            run,
          },
          502,
        );
      }

      reply = result.text;
      mode = 'model';
      usedModel = result.model;
    } else {
      reply = buildAgentReply(workflow, message, analysis);
      mode = 'simulated';
    }

    const priority =
      mode === 'model'
        ? (parsePriority(reply) ?? analysis.priority)
        : analysis.priority;

    const run = await createChatRun(
      workflow,
      message,
      { ...analysis, priority },
      {
        reply,
        engine: mode === 'model' ? 'model' : 'simulated',
        model: usedModel,
        runId: claimedRunId ?? undefined,
        trace: {
          requestId: directRequest.requestId,
          sessionId: directRequest.sessionId,
          durationMs: Date.now() - startedAt,
          attempts: 1,
          mode: mode === 'model' ? 'llm' : 'simulated',
          degraded: mode !== 'model',
        },
      },
    );

    return chatResponse({
      reply,
      intent: analysis.intent,
      priority,
      keywords: analysis.keywords,
      run,
      mode,
      executionMode: run.mode,
      degraded: run.degraded ?? false,
      provider: selection.selection.providerId,
      providerLabel: selection.selection.providerLabel,
      model: usedModel,
      requestId: directRequest.requestId,
      sessionId: directRequest.sessionId,
      errorCode: null,
    });
  } finally {
    if (incomingRequestId) {
      try {
        await releaseClaim(incomingRequestId);
      } catch {
        // 释放失败只影响一次重试要等 TTL，不影响本次结果
      }
    }
  }
}
