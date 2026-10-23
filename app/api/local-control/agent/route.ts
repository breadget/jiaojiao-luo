import { resolveLlmSelection } from '@/lib/server/llm';
import { isLlmReasoningEffort } from '@/lib/llm/providers';
import {
  LOCAL_CONTROL_TASK_ID_PATTERN,
  type LocalControlRunObservation,
} from '@/lib/local-control-protocol';
import { requireLocalControlRequest } from '@/lib/server/local-control-access';
import { runLocalControlAgent } from '@/lib/server/local-control-agent-runtime';
import {
  consumerSessionErrorResponse,
  getOrCreateConsumerSession,
  upsertConsumerMessage,
  type ConsumerSession,
} from '@/lib/server/consumer-store';
import { enforceRateLimit, readJsonObject } from '@/lib/server/security';
import { getWorkflowById } from '@/lib/server/workflow-store';

const MESSAGE_LIMIT = 4_000;

function readOptionalString(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(value);
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function clip(value: string, maximum = 320): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

function metadataRun(run: LocalControlRunObservation) {
  return {
    runId: run.run_id,
    status: run.status,
    command: clip(run.command, 480),
    cwd: clip(run.cwd, 360),
    timeoutSeconds: run.timeout_seconds,
    reason: run.reason ? clip(run.reason, 240) : null,
    exitCode: run.exit_code,
    signal: run.signal,
    stdout: clip(run.stdout, 420),
    stderr: clip(run.stderr, 420),
    stdoutTruncated: run.stdout_truncated || run.stdout.length > 420,
    stderrTruncated: run.stderr_truncated || run.stderr.length > 420,
    cancellationRequested: run.cancellation_requested,
    createdAt: run.created_at,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    error: run.error,
  };
}

function responseRun(run: LocalControlRunObservation) {
  return {
    ...metadataRun(run),
    command: clip(run.command, 4_000),
    stdout: clip(run.stdout, 8_000),
    stderr: clip(run.stderr, 8_000),
    stdoutTruncated: run.stdout_truncated || run.stdout.length > 8_000,
    stderrTruncated: run.stderr_truncated || run.stderr.length > 8_000,
  };
}

export async function POST(request: Request) {
  const accessError = requireLocalControlRequest(request);
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'local-control-agent',
    limit: 12,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const parsed = await readJsonObject(request, 64 * 1024);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body;
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > MESSAGE_LIMIT) {
    return Response.json(
      { error: `任务内容必须为 1-${MESSAGE_LIMIT} 个字符。` },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const selection = resolveLlmSelection({
    provider: readOptionalString(body.provider, 40),
    baseUrl: readOptionalString(body.baseUrl, 400),
    model: readOptionalString(body.model, 120),
  });
  if (!selection.ok) {
    return Response.json(
      { error: selection.error, errorCode: selection.code },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const reasoningEffort =
    body.reasoningEffort === undefined
      ? 'auto'
      : isLlmReasoningEffort(body.reasoningEffort)
        ? body.reasoningEffort
        : null;
  if (!reasoningEffort) {
    return Response.json(
      { error: '推理强度只能是 auto、low、medium 或 high。' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const taskId = `localtask_${randomHex(16)}`;
  if (!LOCAL_CONTROL_TASK_ID_PATTERN.test(taskId)) {
    return Response.json(
      { error: '无法生成本机控制任务编号。' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const workflowId =
    typeof body.workflowId === 'string' ? body.workflowId.trim() : '';
  const agentMessageId =
    typeof body.agentMessageId === 'string' ? body.agentMessageId.trim() : '';
  const consumerSessionId =
    typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined;
  let consumerSession: ConsumerSession | null = null;
  let setConsumerCookie: string | null = null;
  if (workflowId || agentMessageId) {
    if (!workflowId || !agentMessageId) {
      return Response.json(
        { error: 'workflowId 和 agentMessageId 必须同时提供。' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    try {
      const workflow = await getWorkflowById(workflowId);
      if (!workflow?.publishedSteps) {
        return Response.json(
          { error: '当前工作流尚未发布。' },
          { status: 409, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      const resolved = await getOrCreateConsumerSession(
        request,
        workflowId,
        consumerSessionId,
      );
      consumerSession = resolved.session;
      setConsumerCookie = resolved.setCookie;
      await upsertConsumerMessage(consumerSession, {
        id: agentMessageId,
        role: 'agent',
        status: 'working',
        text: '',
        metadata: {
          shell: {
            taskId,
            runs: [],
            succeeded: false,
            stopReason: 'running',
          },
        },
      });
    } catch (cause) {
      return consumerSessionErrorResponse(cause);
    }
  }

  const observed = new Map<string, LocalControlRunObservation>();
  let result;
  try {
    result = await runLocalControlAgent({
      taskId,
      task: message,
      llm: {
        apiKey: readOptionalString(body.apiKey, 400) ?? '',
        provider: selection.selection.providerId,
        baseUrl: selection.selection.baseUrl,
        model: selection.selection.model,
        reasoningEffort,
      },
      onObservation: async (observation) => {
        observed.set(observation.run_id, observation);
        if (!consumerSession) return;
        await upsertConsumerMessage(consumerSession, {
          id: agentMessageId,
          role: 'agent',
          status: 'working',
          text: '',
          metadata: {
            shell: {
              taskId,
              runs: [...observed.values()].map(metadataRun),
              succeeded: false,
              stopReason: 'running',
            },
          },
        });
      },
    });
  } catch (cause) {
    const messageText =
      cause instanceof Error ? cause.message : '本机 Control Agent 启动失败。';
    if (consumerSession) {
      try {
        await upsertConsumerMessage(consumerSession, {
          id: agentMessageId,
          role: 'agent',
          status: 'failed',
          text: messageText,
          metadata: {
            shell: {
              taskId,
              runs: [...observed.values()].map(metadataRun),
              succeeded: false,
              stopReason: 'tool_rejected',
            },
          },
        });
      } catch {
        // Keep the original service failure as the response.
      }
    }
    return Response.json(
      { error: messageText, code: 'LOCAL_CONTROL_UNAVAILABLE' },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
          ...(setConsumerCookie ? { 'Set-Cookie': setConsumerCookie } : {}),
        },
      },
    );
  }

  const payload = {
    reply: result.reply,
    replySource: result.replySource,
    taskId,
    usedShell: result.usedShell,
    succeeded: result.succeeded,
    stopReason: result.stopReason,
    commands: result.commands,
    runs: result.runs.map(responseRun),
    model: result.model,
    provider: selection.selection.providerId,
    providerLabel: selection.selection.providerLabel,
    llmError: result.llmError,
    rejection: result.rejection,
  };

  if (consumerSession) {
    try {
      await upsertConsumerMessage(consumerSession, {
        id: agentMessageId,
        role: 'agent',
        status: result.succeeded ? 'completed' : 'failed',
        text: result.reply,
        metadata: {
          shell: {
            taskId,
            runs: result.runs.map(metadataRun),
            succeeded: result.succeeded,
            stopReason: result.stopReason,
          },
        },
      });
    } catch (cause) {
      return consumerSessionErrorResponse(cause);
    }
  }

  const headers = {
    'Cache-Control': 'no-store',
    ...(setConsumerCookie ? { 'Set-Cookie': setConsumerCookie } : {}),
  };
  if (result.stopReason === 'llm_error' && result.commands === 0) {
    return Response.json(
      {
        ...payload,
        error: result.llmError?.message ?? '模型服务调用失败。',
        errorCode: result.llmError?.code ?? 'LLM_ERROR',
      },
      { status: 502, headers },
    );
  }
  return Response.json(payload, { headers });
}
