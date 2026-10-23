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
import {
  persistChatRunReply,
  persistDatabaseChatProgress,
  programChatReply,
  programInputFromChat,
} from '@/lib/server/consumer-chat';
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
  createAssistantRun,
  createChatRun,
  createN8nRun,
  getRunByRequestId,
  getWorkflowById,
} from '@/lib/server/workflow-store';
import { UNIFIED_ASSISTANT_WORKFLOW_ID } from '@/lib/assistant-identity';
import { ensureUnifiedAssistantWorkflow } from '@/lib/server/assistant-session';
import {
  redactModelCredentials,
  runUnifiedAssistant,
} from '@/lib/server/unified-assistant';
import type {
  ChatKnowledgeEvidence,
  ChatMode,
  RunMode,
  WorkflowRun,
} from '@/lib/workflow-types';
import {
  enforceExecutionAccess,
  enforceRateLimit,
  readJsonObject,
} from '@/lib/server/security';
import { getActiveWorkflowVersion } from '@/lib/server/workflow-version-store';
import {
  getProgramPlan,
  programErrorResponse,
  startOwnedProgram,
} from '@/lib/server/workflow-program-store';
import { hasAgentConstraints } from '@/lib/workflow-graph/agent-constraints';
import { hasLocalDatabaseNodes } from '@/lib/workflow-graph/local-database';
import {
  DATABASE_CHAT_BODY_BYTES,
  DatabaseAgentError,
  runDatabaseAgentTurn,
} from '@/lib/server/database-agent';

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
    run.engine === 'program'
      ? 'program'
      : run.engine === 'n8n'
        ? 'n8n'
        : run.engine === 'model'
          ? 'model'
          : run.engine === 'retrieval'
            ? 'retrieval'
            : 'simulated';
  const executionMode: RunMode =
    run.mode ??
    (run.engine === 'program'
      ? 'program'
      : run.engine === 'model'
        ? 'llm'
        : run.engine === 'simulated'
          ? 'simulated'
          : run.engine === 'retrieval'
            ? 'retrieval'
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
    reply: run.engine === 'program' ? programChatReply(run) : run.output.result,
    intent: analysis.intent,
    priority: analysis.priority,
    keywords: analysis.keywords,
    run,
    ...modesFromRun(run),
    requestId: run.requestId ?? null,
    sessionId: run.sessionId ?? null,
    errorCode: run.errorCode ?? null,
    ...(run.output.knowledge ? { knowledge: run.output.knowledge } : {}),
    ...(run.output.model ? { model: run.output.model } : {}),
    ...(run.output.programJobId
      ? { programJobId: run.output.programJobId }
      : {}),
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

  const parsed = await readJsonObject(request, DATABASE_CHAT_BODY_BYTES);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body;
  if (body.assistantMode !== undefined && body.assistantMode !== 'unified') {
    return Response.json({ error: '智能体模式无效。' }, { status: 400 });
  }
  const unified = body.assistantMode === 'unified';

  if (!unified && (typeof body.workflowId !== 'string' || !body.workflowId)) {
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

  const workflow =
    unified &&
    (!body.workflowId || body.workflowId === UNIFIED_ASSISTANT_WORKFLOW_ID)
      ? await ensureUnifiedAssistantWorkflow()
      : typeof body.workflowId === 'string'
        ? await getWorkflowById(body.workflowId)
        : null;
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
        unified ? UNIFIED_ASSISTANT_WORKFLOW_ID : workflow.id,
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
    setCookie: string | null = null,
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
    return Response.json(payload, {
      status,
      headers: {
        'Cache-Control': 'no-store',
        ...(setCookie ? { 'Set-Cookie': setCookie } : {}),
      },
    });
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
  let n8nMessage = composeContextualMessage(message, conversationHistory);

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
  const incomingSessionId =
    readOptionalString(body.sessionId, 80) ??
    (unified ? consumerSession?.engineSessionId : undefined);
  if (
    unified &&
    consumerSession &&
    incomingSessionId !== consumerSession.engineSessionId
  ) {
    return Response.json(
      { error: '请求与当前聊天会话不匹配。' },
      { status: 409 },
    );
  }
  if (unified && !incomingRequestId) {
    return Response.json(
      { error: '智能体对话需要 requestId，以便安全重试。' },
      { status: 400 },
    );
  }
  if (incomingRequestId && !isSafeRequestId(incomingRequestId)) {
    return requestIdError();
  }

  // 发布快照决定执行端。电脑文件只能交给浏览器连接助手，不能落到旧 n8n 地址。
  const publishedVersion = await getActiveWorkflowVersion(workflow.id);
  const publishedGraph = publishedVersion?.graph;
  const hasLocalDatabases = Boolean(
    publishedGraph && hasLocalDatabaseNodes(publishedGraph),
  );
  if (hasLocalDatabases && !incomingRequestId) {
    return Response.json(
      {
        error: '本机数据库对话需要 requestId，以便安全继续查询。',
        errorCode: 'LOCAL_DATABASE_REQUEST_ID_REQUIRED',
      },
      { status: 400 },
    );
  }
  if (
    hasLocalDatabases &&
    ['filePath', 'sql', 'parameters', 'maxRows', 'databaseRequests'].some(
      (key) => Object.hasOwn(body, key),
    )
  ) {
    return Response.json(
      {
        error:
          '数据库文件和工具参数只能来自发布版本及已签名工具请求，不允许由客户端覆盖。',
        errorCode: 'LOCAL_DATABASE_RESULTS_INVALID',
      },
      { status: 400 },
    );
  }
  if (
    !hasLocalDatabases &&
    (body.databaseSession !== undefined || body.databaseResults !== undefined)
  ) {
    return Response.json(
      {
        error: '当前发布版本没有本机数据库，会话已失效，请重新发送。',
        errorCode: 'LOCAL_DATABASE_SESSION_INVALID',
      },
      { status: 409 },
    );
  }
  if (!unified && publishedVersion?.adapter === 'program-v1') {
    return Response.json(
      {
        error:
          '当前工作流已发布为程序。请点击「运行程序」打开参数面板，填写输入后运行；普通提问可继续使用 AI 对话。',
        errorCode: 'PROGRAM_INPUT_PANEL_REQUIRED',
      },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let unifiedClaimedRunId: string | null = null;
  let unifiedKnowledge: ChatKnowledgeEvidence | undefined;
  let unifiedContext = '';
  if (unified && incomingRequestId) {
    const decision = decideReplay(
      await getRunByRequestId(incomingRequestId),
      workflow.id,
      incomingSessionId,
    );
    if (decision.kind === 'conflict')
      return Response.json({ error: decision.message }, { status: 409 });
    if (decision.kind === 'replay') return chatReplayResponse(decision.run);
    const claim = await claimRunRequest(incomingRequestId);
    if (claim.kind === 'in_progress') {
      const settled = await waitForSettledRun(incomingRequestId);
      if (!settled) return inProgressError(incomingRequestId);
      const settledDecision = decideReplay(
        settled,
        workflow.id,
        incomingSessionId,
      );
      if (settledDecision.kind === 'conflict')
        return Response.json(
          { error: settledDecision.message },
          { status: 409 },
        );
      return chatReplayResponse(settled);
    }
    unifiedClaimedRunId = claim.runId;
  }

  // The shared router and every downstream execution live under the same claim.
  try {
    // Signed SQLite continuations are verified by runDatabaseAgentTurn below.
    // Never re-route a pending tool response through the general chat model.
    if (
      unified &&
      incomingRequestId &&
      body.databaseSession === undefined &&
      body.databaseResults === undefined
    ) {
      const startedAt = Date.now();
      const shared = await runUnifiedAssistant({
        message,
        workflow,
        graph: publishedGraph,
        history: conversationHistory,
        llm: {
          apiKey: apiKey ?? '',
          provider: selection.selection.providerId,
          baseUrl,
          model,
          reasoningEffort,
        },
        shouldCallModel: Boolean(apiKey) || !selection.selection.keyRequired,
      });
      unifiedKnowledge = shared.knowledge;
      if (shared.kind !== 'workflow') {
        const failed = shared.kind === 'failed';
        const reply = failed ? shared.error : shared.reply;
        // Upstream failures can echo request headers; never save the user's Key.
        const safeReply = redactModelCredentials(reply, {
          apiKey: apiKey ?? '',
          baseUrl,
        });
        const directRequest = buildRequest({
          workflowId: workflow.id,
          message,
          requestId: incomingRequestId,
          sessionId: incomingSessionId ?? null,
          source: 'urtoris-web',
          workflowVersion: workflow.version,
        });
        const run = await createAssistantRun(workflow, message, {
          reply: safeReply,
          engine: shared.engine,
          knowledge: shared.knowledge,
          ...(shared.kind === 'answer' && shared.model
            ? { model: shared.model }
            : {}),
          startedAt,
          requestId: directRequest.requestId,
          sessionId: directRequest.sessionId,
          runId: unifiedClaimedRunId ?? undefined,
          ...(failed ? { errorCode: shared.code } : {}),
        });
        return chatResponse(
          {
            ...(failed
              ? { error: safeReply, errorCode: shared.code }
              : { reply: safeReply, errorCode: null }),
            intent: analysis.intent,
            priority: analysis.priority,
            keywords: analysis.keywords,
            run,
            mode: shared.engine,
            executionMode: run.mode,
            degraded: run.degraded,
            knowledge: shared.knowledge,
            provider: selection.selection.providerId,
            providerLabel: selection.selection.providerLabel,
            ...(shared.kind === 'answer' && shared.model
              ? { model: shared.model }
              : {}),
            requestId: directRequest.requestId,
            sessionId: directRequest.sessionId,
          },
          failed ? 502 : 200,
        );
      }
      unifiedContext = shared.context;
      // Pass the same evidence and full conversation to the selected execution;
      // credentials stay only in the transient llm object.
      n8nMessage = [n8nMessage ?? message, unifiedContext].join('\n\n');
    }

    // A shared-router tool decision authorizes the fixed published program,
    // rather than the legacy webhook, model-only path or simulated executor.
    if (publishedVersion?.adapter === 'program-v1' && incomingRequestId) {
      try {
        const plan = await getProgramPlan(publishedVersion);
        const derived = programInputFromChat(plan, message);
        if (derived.missing.length)
          return Response.json(
            {
              error: `这个程序还需要填写：${derived.missing.join('、')}。请点击「运行程序」打开参数面板，补全后运行。`,
              errorCode: 'PROGRAM_INPUT_PANEL_REQUIRED',
            },
            { status: 409, headers: { 'Cache-Control': 'no-store' } },
          );
        const started = await startOwnedProgram(
          request,
          {
            workflowId: workflow.id,
            versionId: publishedVersion.id,
            requestId: incomingRequestId,
            input: derived.input,
            llm: {
              apiKey: apiKey ?? '',
              provider: selection.selection.providerId,
              baseUrl,
              model,
              reasoningEffort,
            },
            consumerSessionId: consumerSession?.id,
          },
          { claimHeld: true },
        );
        const run = await getRunByRequestId(incomingRequestId);
        if (
          !run ||
          run.engine !== 'program' ||
          run.output.programJobId !== started.job.id
        )
          throw new Error('程序运行记录尚未保存。');
        consumerSession = started.session;
        const failed = run.status === 'failed';
        const reply = programChatReply(run);
        return chatResponse(
          {
            reply,
            ...(failed ? { error: reply } : {}),
            intent: analysis.intent,
            priority: analysis.priority,
            keywords: analysis.keywords,
            mode: 'program' satisfies ChatMode,
            executionMode: 'program' satisfies RunMode,
            degraded: false,
            programJobId: started.job.id,
            run,
            requestId: incomingRequestId,
            sessionId: started.session.engineSessionId,
            consumerSessionId: started.session.id,
            errorCode: run.errorCode ?? null,
            ...(started.replayed ? { replayed: true } : {}),
          },
          failed ? 502 : ['queued', 'running'].includes(run.status) ? 202 : 200,
          started.setCookie,
        );
      } catch (cause) {
        return programErrorResponse(cause);
      }
    }

    // ── 分支一：工作流绑定了 n8n webhook → 一切交给真实引擎 ──
    // 关键点：模型 Key 不是存在 n8n 里，而是随请求透传给 n8n（BYO Key）。
    if (workflow.n8nWebhookUrl && !hasLocalDatabases) {
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

      let claimedRunId: string | null = unifiedClaimedRunId;
      if (incomingRequestId && !unified) {
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
        llm: unified
          ? {
              apiKey: apiKey ?? '',
              provider: selection.selection.providerId,
              baseUrl,
              model,
              reasoningEffort,
            }
          : apiKey
            ? { apiKey, baseUrl, model, reasoningEffort }
            : null,
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
          ...(unified ? { maxAttempts: 1, timeoutMs: 45_000 } : {}),
        });
        const envelope = unified
          ? (JSON.parse(
              JSON.stringify(result.envelope, (_key, value) =>
                typeof value === 'string'
                  ? redactModelCredentials(value, {
                      apiKey: apiKey ?? '',
                      baseUrl,
                    })
                  : value,
              ),
            ) as typeof result.envelope)
          : result.envelope;

        const run = await createN8nRun(workflow, envelope, {
          message,
          startedAt,
          sessionId: envelopeRequest.sessionId,
          runId: claimedRunId ?? undefined,
          ...(unifiedKnowledge ? { knowledge: unifiedKnowledge } : {}),
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
              ...(run.output.knowledge
                ? { knowledge: run.output.knowledge }
                : {}),
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
          ...(run.output.knowledge ? { knowledge: run.output.knowledge } : {}),
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
        if (incomingRequestId && !unified) {
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

    // 运行时只读取发布快照，草稿修改不能提前改变 Agent 的行为边界。
    const shouldCallModel = Boolean(apiKey) || !selection.selection.keyRequired;
    if (!shouldCallModel && hasLocalDatabases) {
      return Response.json(
        {
          error:
            '本机数据库查询需要真实模型，请配置 API Key 或连接可用的本机模型后重试。',
          errorCode: 'LOCAL_DATABASE_REQUIRE_MODEL',
        },
        { status: 409 },
      );
    }
    if (!shouldCallModel && hasAgentConstraints(publishedGraph)) {
      return Response.json(
        {
          error:
            '当前工作流的 Agent 配置了自然语言行为限制，模拟执行无法应用这些限制。请配置 API Key 或连接本机模型后重试。',
          errorCode: 'AGENT_CONSTRAINTS_REQUIRE_MODEL',
        },
        { status: 409 },
      );
    }

    let claimedRunId: string | null = unifiedClaimedRunId;
    if (incomingRequestId && !unified) {
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
      let startedAt = Date.now();
      let modelTurns = 1;
      let reply: string;
      let mode: ChatMode;
      let usedModel: string | undefined;

      // 本机模型（Ollama）这类服务不需要 Key：只要服务本身允许免 Key，就照样真调模型。
      if (shouldCallModel) {
        const history: ChatMessage[] = [
          {
            role: 'system',
            content: buildWorkflowSystemPrompt(workflow, publishedGraph, {
              hasConversationHistory: conversationHistory.length > 0,
            }),
          },
          ...conversationHistory,
          ...(unifiedContext
            ? [{ role: 'user' as const, content: unifiedContext }]
            : []),
          { role: 'user', content: message },
        ];
        const llm = {
          apiKey: apiKey ?? '',
          provider: selection.selection.providerId,
          baseUrl,
          model,
          reasoningEffort,
        };
        let result;
        if (
          hasLocalDatabases &&
          publishedGraph &&
          publishedVersion &&
          incomingRequestId
        ) {
          try {
            const progressSession = consumerSession;
            const databaseTurn = await runDatabaseAgentTurn({
              graph: publishedGraph,
              binding: {
                workflowId: workflow.id,
                versionId: publishedVersion.id,
                requestId: incomingRequestId,
                sessionId: incomingSessionId ?? null,
                consumerSessionId: consumerSessionId ?? null,
                agentMessageId: agentMessageId ?? null,
                userMessageId: historyOptions.currentMessageId ?? null,
                message,
                provider: selection.selection.providerId,
                baseUrl,
                model,
                reasoningEffort,
              },
              messages: history.map((entry) =>
                entry.role === 'assistant'
                  ? { ...entry, role: 'assistant' as const, toolCalls: [] }
                  : { ...entry, role: entry.role as 'system' | 'user' },
              ),
              llm,
              ...(unified ? { modelBudgetMs: 45_000 } : {}),
              databaseSession: body.databaseSession,
              databaseResults: body.databaseResults,
              onProgress:
                progressSession && agentMessageId
                  ? (expiresAt) =>
                      persistDatabaseChatProgress(
                        progressSession,
                        agentMessageId,
                        incomingRequestId,
                        publishedVersion.id,
                        expiresAt,
                        unified ? workflow.id : undefined,
                      )
                  : undefined,
            });
            if (databaseTurn.kind === 'pending') {
              return Response.json(
                {
                  mode: 'local-database',
                  requestId: incomingRequestId,
                  database: databaseTurn.database,
                },
                { headers: { 'Cache-Control': 'no-store' } },
              );
            }
            startedAt = databaseTurn.startedAt;
            modelTurns = databaseTurn.turns;
            result =
              databaseTurn.kind === 'completed'
                ? {
                    ok: true as const,
                    text: databaseTurn.text,
                    model: databaseTurn.model,
                  }
                : {
                    ok: false as const,
                    error: databaseTurn.error,
                    code: databaseTurn.code,
                  };
          } catch (cause) {
            if (cause instanceof DatabaseAgentError) {
              return Response.json(
                { error: cause.message, errorCode: cause.code },
                {
                  status: cause.status,
                  headers: { 'Cache-Control': 'no-store' },
                },
              );
            }
            throw cause;
          }
        } else {
          result = await callChatModel({ ...llm, messages: history });
        }

        if (!result.ok) {
          // 用户主动提供了 Key，失败时不降级、不伪装成功，且失败记录也参与幂等重放。
          const run = await createChatRun(workflow, message, analysis, {
            reply: unified
              ? redactModelCredentials(result.error, {
                  apiKey: apiKey ?? '',
                  baseUrl,
                })
              : result.error,
            engine: 'model',
            model,
            ...(unifiedKnowledge ? { knowledge: unifiedKnowledge } : {}),
            preserveReply: unified,
            runId: claimedRunId ?? undefined,
            trace: {
              requestId: directRequest.requestId,
              sessionId: directRequest.sessionId,
              errorCode: result.code,
              errorMessage: unified
                ? redactModelCredentials(result.error, {
                    apiKey: apiKey ?? '',
                    baseUrl,
                  })
                : result.error,
              durationMs: Date.now() - startedAt,
              attempts: modelTurns,
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
              ...(run.output.knowledge
                ? { knowledge: run.output.knowledge }
                : {}),
            },
            502,
          );
        }

        reply = unified
          ? redactModelCredentials(result.text, {
              apiKey: apiKey ?? '',
              baseUrl,
            })
          : result.text;
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
          ...(unifiedKnowledge ? { knowledge: unifiedKnowledge } : {}),
          preserveReply: unified,
          runId: claimedRunId ?? undefined,
          trace: {
            requestId: directRequest.requestId,
            sessionId: directRequest.sessionId,
            durationMs: Date.now() - startedAt,
            attempts: modelTurns,
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
        ...(run.output.knowledge ? { knowledge: run.output.knowledge } : {}),
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
      if (incomingRequestId && !unified) {
        try {
          await releaseClaim(incomingRequestId);
        } catch {
          // 释放失败只影响一次重试要等 TTL，不影响本次结果
        }
      }
    }
  } finally {
    if (unified && incomingRequestId && unifiedClaimedRunId) {
      try {
        await releaseClaim(incomingRequestId);
      } catch {
        /* Durable runs remain replayable. */
      }
    }
  }
}
