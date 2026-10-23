import { env } from 'cloudflare:workers';
import type { LlmReasoningEffort } from '@/lib/llm/providers';
import { callChatModelTurn } from '@/lib/server/llm';
import {
  PythonExecutorClientError,
  callPythonExecutor,
} from '@/lib/server/python-executor-client';
import {
  readPythonRunObservation,
  runPythonAgentTask,
  type PythonAgentInputFile,
  type PythonAgentRejectionCode,
  type PythonAgentTaskResult,
  type PythonAgentToolOutcome,
  type PythonRunCall,
  type PythonRunObservation,
} from '@/lib/server/python-agent';

/**
 * 真实运行时：把 Agent 状态机接到模型服务和 loopback Python Executor 上。
 *
 * 这是 `docs/python-agent-system-prompt.md` 里那句前置条件的落点：只有
 * `PYTHON_AGENT_ENABLED` 显式打开、且 Executor 已按 loopback + 内部 token
 * 配置好时，才会把 `run_python` 交给模型；否则一律 fail closed。
 */

const ENABLED_VALUES = new Set(['1', 'true', 'on', 'yes']);

const TOOL_ERROR_CODES = new Set<PythonAgentRejectionCode>([
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'FILE_UNAVAILABLE',
  'ATTEMPT_LIMIT',
  'IDEMPOTENCY_CONFLICT',
  'CAPACITY_EXCEEDED',
]);

/** Agent 是否已经获准使用 `run_python`。默认关闭。 */
export function isPythonAgentEnabled(): boolean {
  const raw = env.PYTHON_AGENT_ENABLED?.trim().toLowerCase() ?? '';
  return ENABLED_VALUES.has(raw);
}

async function executeRunPython(
  call: PythonRunCall,
  onObservation?: (observation: PythonRunObservation) => void | Promise<void>,
): Promise<PythonAgentToolOutcome> {
  let response: Response;
  try {
    response = await callPythonExecutor('/v1/runs', {
      method: 'POST',
      body: JSON.stringify(call),
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: 10_000,
    });
  } catch (cause) {
    return {
      kind: 'rejected',
      code: 'EXECUTOR_UNAVAILABLE',
      message:
        cause instanceof PythonExecutorClientError
          ? cause.message
          : 'Python Executor 调用失败。',
      retryable: false,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      kind: 'rejected',
      code: 'WORKER_ERROR',
      message: 'Executor 没有返回可解析的结构化结果。',
      retryable: false,
    };
  }

  if (!response.ok) {
    const envelope =
      payload && typeof payload === 'object'
        ? (payload as { error?: unknown }).error
        : undefined;
    const rawCode =
      envelope && typeof envelope === 'object'
        ? (envelope as { code?: unknown }).code
        : undefined;
    const rawMessage =
      envelope && typeof envelope === 'object'
        ? (envelope as { message?: unknown }).message
        : undefined;
    const code =
      typeof rawCode === 'string' &&
      TOOL_ERROR_CODES.has(rawCode as PythonAgentRejectionCode)
        ? (rawCode as PythonAgentRejectionCode)
        : 'INVALID_REQUEST';
    return {
      kind: 'rejected',
      code,
      // 只回显执行器的固定英文说明，不回显任何内部细节。
      message: typeof rawMessage === 'string' ? rawMessage.slice(0, 200) : '',
      retryable: false,
    };
  }

  const observation = readPythonRunObservation(payload);
  if (!observation) {
    return {
      kind: 'rejected',
      code: 'WORKER_ERROR',
      message: 'Executor 返回的结果结构不符合协议，本次不采信。',
      retryable: false,
    };
  }
  await onObservation?.(observation);
  if (observation.status !== 'queued' && observation.status !== 'running') {
    return { kind: 'result', observation };
  }

  // POST 只负责持久化并返回 run_id；每个 Agent 工具回合再通过 GET
  // 等到终态。总等待时间由这次请求的沙箱上限决定，另留 60 秒给
  // 排队、产物校验和容器清理；不再把单次 HTTP 的 30 秒当成任务上限。
  const deadline = Date.now() + call.timeout_seconds * 1000 + 60_000;
  let current = observation;
  let delayMs = 250;
  while (current.status === 'queued' || current.status === 'running') {
    if (Date.now() >= deadline) {
      return {
        kind: 'rejected',
        code: 'WORKER_ERROR',
        message: `Executor 在运行 ${current.runId} 时未在预期时间内给出终态。`,
        retryable: false,
      };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    delayMs = Math.min(1_000, Math.round(delayMs * 1.5));

    let polled: Response;
    try {
      polled = await callPythonExecutor(
        `/v1/runs/${encodeURIComponent(current.runId)}`,
        {
          method: 'GET',
          headers: { 'X-Urtoris-Task-Id': call.task_id },
          timeoutMs: 10_000,
        },
      );
    } catch (cause) {
      return {
        kind: 'rejected',
        code: 'EXECUTOR_UNAVAILABLE',
        message:
          cause instanceof PythonExecutorClientError
            ? cause.message
            : 'Python Executor 轮询失败。',
        retryable: false,
      };
    }
    let polledPayload: unknown;
    try {
      polledPayload = await polled.json();
    } catch {
      return {
        kind: 'rejected',
        code: 'WORKER_ERROR',
        message: 'Executor 状态轮询没有返回可解析的结果。',
        retryable: false,
      };
    }
    const next = polled.ok ? readPythonRunObservation(polledPayload) : null;
    if (!next || next.runId !== observation.runId) {
      return {
        kind: 'rejected',
        code: 'WORKER_ERROR',
        message: 'Executor 返回的轮询结果不符合本次运行协议。',
        retryable: false,
      };
    }
    current = next;
    await onObservation?.(current);
  }
  return { kind: 'result', observation: current };
}

export type PythonAgentLlmConfig = {
  apiKey: string;
  provider?: string | null;
  baseUrl?: string;
  model?: string;
  reasoningEffort?: LlmReasoningEffort;
};

export type PythonAgentRunOptions = {
  taskId: string;
  task: string;
  inputs: ReadonlyArray<PythonAgentInputFile>;
  artifactsAllowed?: boolean;
  requireArtifact?: boolean;
  llm: PythonAgentLlmConfig;
  maxModelTurns?: number;
  onRunObservation?: (
    observation: PythonRunObservation,
  ) => void | Promise<void>;
};

export async function runPythonAgent(
  options: PythonAgentRunOptions,
): Promise<PythonAgentTaskResult> {
  return runPythonAgentTask({
    taskId: options.taskId,
    task: options.task,
    inputs: options.inputs,
    artifactsAllowed: options.artifactsAllowed ?? true,
    requireArtifact: options.requireArtifact,
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
      }),
    execute: (call) => executeRunPython(call, options.onRunObservation),
  });
}
