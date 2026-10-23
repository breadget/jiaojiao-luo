import { callChatModelTurn, type ChatMessage } from '@/lib/server/llm';
import type { LlmReasoningEffort } from '@/lib/llm/providers';
import {
  LOCAL_CONTROL_LIMITS,
  readLocalControlInfo,
  readLocalControlRunObservation,
  type LocalControlInfo,
  type LocalControlRunObservation,
  type LocalControlSubmission,
} from '@/lib/local-control-protocol';
import {
  runLocalControlAgentTask,
  type LocalControlAgentResult,
  type LocalControlToolOutcome,
} from '@/lib/server/local-control-agent';
import {
  callLocalControl,
  LocalControlClientError,
} from '@/lib/server/local-control-client';

export type LocalControlAgentRunOptions = {
  taskId: string;
  task: string;
  /** 同一个使用端会话里更早的对话轮次。 */
  history?: ReadonlyArray<ChatMessage>;
  llm: {
    apiKey: string;
    provider?: string | null;
    baseUrl?: string;
    model?: string;
    reasoningEffort?: LlmReasoningEffort;
  };
  maxCommands?: number;
  maxModelTurns?: number;
  onObservation?: (
    observation: LocalControlRunObservation,
  ) => void | Promise<void>;
};

function rejectionFromPayload(
  payload: unknown,
  fallback: string,
): { code: string; message: string } {
  if (payload && typeof payload === 'object') {
    const error = (payload as { error?: unknown }).error;
    if (error && typeof error === 'object') {
      const code = (error as { code?: unknown }).code;
      const message = (error as { message?: unknown }).message;
      return {
        code: typeof code === 'string' ? code : 'WORKER_ERROR',
        message: typeof message === 'string' ? message.slice(0, 500) : fallback,
      };
    }
  }
  return { code: 'WORKER_ERROR', message: fallback };
}

async function jsonPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function getLocalControlInfo(): Promise<LocalControlInfo> {
  const response = await callLocalControl('/v1/info', {
    method: 'GET',
    timeoutMs: 5_000,
  });
  const payload = await jsonPayload(response);
  if (!response.ok) {
    const rejection = rejectionFromPayload(
      payload,
      '本机控制服务拒绝了身份查询。',
    );
    throw new LocalControlClientError(
      rejection.message,
      'LOCAL_CONTROL_UNAVAILABLE',
    );
  }
  const info = readLocalControlInfo(payload);
  if (!info) {
    throw new LocalControlClientError(
      '本机控制服务返回了无法验证的身份信息。',
      'LOCAL_CONTROL_UNAVAILABLE',
    );
  }
  return info;
}

async function executeShell(
  call: LocalControlSubmission,
  onObservation?: (
    observation: LocalControlRunObservation,
  ) => void | Promise<void>,
): Promise<LocalControlToolOutcome> {
  let response: Response;
  try {
    response = await callLocalControl('/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(call),
      timeoutMs: 10_000,
    });
  } catch (cause) {
    return {
      kind: 'rejected',
      code:
        cause instanceof LocalControlClientError
          ? cause.code
          : 'LOCAL_CONTROL_UNAVAILABLE',
      message:
        cause instanceof Error ? cause.message : '无法连接本机控制服务。',
    };
  }
  const payload = await jsonPayload(response);
  if (!response.ok) {
    return {
      kind: 'rejected',
      ...rejectionFromPayload(payload, '本机控制服务拒绝了命令。'),
    };
  }
  const submitted = readLocalControlRunObservation(payload);
  if (!submitted || submitted.task_id !== call.task_id) {
    return {
      kind: 'rejected',
      code: 'WORKER_ERROR',
      message: '本机控制服务返回的运行结构无法验证。',
    };
  }
  await onObservation?.(submitted);
  if (submitted.status !== 'queued' && submitted.status !== 'running') {
    return { kind: 'result', observation: submitted };
  }

  const timeoutSeconds =
    call.timeout_seconds ?? LOCAL_CONTROL_LIMITS.defaultTimeoutSeconds;
  const deadline = Date.now() + (timeoutSeconds + 60) * 1000;
  let current = submitted;
  let previousSignature = `${current.status}:${current.cancellation_requested}`;
  let delayMs = 250;
  while (current.status === 'queued' || current.status === 'running') {
    if (Date.now() >= deadline) {
      return {
        kind: 'rejected',
        code: 'WORKER_ERROR',
        message: `本机命令 ${current.run_id} 没有在预期时间内返回终态。`,
      };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    delayMs = Math.min(1_000, Math.round(delayMs * 1.45));
    try {
      response = await callLocalControl(
        `/v1/runs/${encodeURIComponent(current.run_id)}`,
        {
          method: 'GET',
          headers: { 'X-Urtoris-Local-Task-Id': call.task_id },
          timeoutMs: 10_000,
        },
      );
    } catch (cause) {
      return {
        kind: 'rejected',
        code:
          cause instanceof LocalControlClientError
            ? cause.code
            : 'LOCAL_CONTROL_UNAVAILABLE',
        message:
          cause instanceof Error ? cause.message : '本机命令状态轮询失败。',
      };
    }
    const nextPayload = await jsonPayload(response);
    const next = response.ok
      ? readLocalControlRunObservation(nextPayload)
      : null;
    if (!next || next.run_id !== submitted.run_id) {
      return {
        kind: 'rejected',
        ...rejectionFromPayload(
          nextPayload,
          '本机控制服务返回的轮询结果无法验证。',
        ),
      };
    }
    current = next;
    const signature = `${current.status}:${current.cancellation_requested}`;
    if (
      signature !== previousSignature ||
      (current.status !== 'queued' && current.status !== 'running')
    ) {
      previousSignature = signature;
      await onObservation?.(current);
    }
  }
  return { kind: 'result', observation: current };
}

export async function runLocalControlAgent(
  options: LocalControlAgentRunOptions,
): Promise<LocalControlAgentResult> {
  const machine = await getLocalControlInfo();
  return runLocalControlAgentTask({
    taskId: options.taskId,
    task: options.task,
    machine,
    history: options.history,
    maxCommands: options.maxCommands,
    maxModelTurns: options.maxModelTurns,
    turn: (input) =>
      callChatModelTurn({
        apiKey: options.llm.apiKey,
        provider: options.llm.provider,
        baseUrl: options.llm.baseUrl,
        model: options.llm.model,
        reasoningEffort: options.llm.reasoningEffort,
        messages: input.messages,
        tools: input.tools,
        toolChoice: input.toolChoice,
        timeoutMs: 90_000,
      }),
    execute: (call) => executeShell(call, options.onObservation),
  });
}
