import type {
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
} from '@/lib/server/llm';
import { PYTHON_ATTACHMENT_EXTENSIONS } from '@/lib/python-attachments';
import {
  PYTHON_AGENT_TOOL,
  PYTHON_AGENT_TOOL_NAME,
  buildPythonAgentSystemPrompt,
} from '@/lib/server/python-agent-prompt';

/**
 * Python Executor Agent 的 Orchestrator 状态机。
 *
 * 这里只做三件事，且全部按 `docs/python-agent-system-prompt.md` 与
 * `docs/tool-contract.md` 的规则执行：
 *  1. 校验模型提交的 `run_python` 参数（授权、次数、幂等、限额）；
 *  2. 把结构化结果喂回模型，并决定「继续修复」还是「停止」；
 *  3. 用确定性代码兜底最终回答，保证失败不会被写成成功。
 *
 * 它不直接发网络请求：模型回合（`turn`）和执行器调用（`execute`）都由调用方注入，
 * 所以状态机可以在没有 Docker、没有模型 Key 的情况下被完整测试。
 */

export const PYTHON_EXECUTOR_PROTOCOL_ID = 'urtoris.python-executor.v1';
export const PYTHON_AGENT_MAX_ATTEMPTS = 3;
export const PYTHON_AGENT_MAX_MODEL_TURNS = 6;
export const PYTHON_AGENT_MAX_INPUT_FILES = 10;
export const PYTHON_CODE_MAX_BYTES = 64 * 1024;
export const PYTHON_PROFILE_LIMITS = Object.freeze({
  short: 30,
  long: 10 * 60,
});
export type PythonRunProfile = keyof typeof PYTHON_PROFILE_LIMITS;
export const PYTHON_TIMEOUT_MAX_SECONDS = PYTHON_PROFILE_LIMITS.short;

export const PYTHON_FILE_ID_PATTERN = /^file_[a-f0-9]{32}$/;
export const PYTHON_MOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INPUT_EXTENSIONS = new Set<string>(PYTHON_ATTACHMENT_EXTENSIONS);

export type PythonRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'killed';

export type PythonRunErrorCode =
  | 'PROCESS_EXIT_NONZERO'
  | 'WORKER_ERROR'
  | 'TIMEOUT'
  | 'MEMORY_LIMIT'
  | 'PROCESS_LIMIT'
  | 'POLICY_VIOLATION'
  | 'CANCELLED'
  | 'ARTIFACT_REJECTED';

export type PythonToolErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FILE_UNAVAILABLE'
  | 'ATTEMPT_LIMIT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CAPACITY_EXCEEDED';

/** Orchestrator 自己产生的两类终止原因，不属于执行器协议。 */
export type PythonAgentRejectionCode =
  | PythonToolErrorCode
  | 'EXECUTOR_UNAVAILABLE'
  | 'WORKER_ERROR';

const REJECTION_ACTIONS: Record<PythonAgentRejectionCode, string> = {
  INVALID_REQUEST: '请求没有通过执行器校验，需要修正参数后重新提交。',
  UNAUTHORIZED: '执行器授权失效，需要重新开始任务。',
  FILE_UNAVAILABLE: '需要重新上传这次任务要用的输入文件。',
  ATTEMPT_LIMIT: '这个任务不能再执行新的 Python 尝试，需要开始一个新任务。',
  IDEMPOTENCY_CONFLICT:
    '这次尝试已经用过不同的代码，需要开始新任务而不是换 key 重试。',
  CAPACITY_EXCEEDED: '执行器繁忙，需要稍后再试。',
  EXECUTOR_UNAVAILABLE: '执行器当前不可用，需要稍后再试或联系管理员。',
  WORKER_ERROR: '执行基础设施失败，需要稍后再试或联系管理员。',
};

/** 可以自动修复的运行错误：其余错误必须停止并如实报告。 */
const RETRYABLE_RUN_CODES = new Set<PythonRunErrorCode>([
  'PROCESS_EXIT_NONZERO',
  'ARTIFACT_REJECTED',
]);

/** 停止后必须向用户说明下一步动作的工具错误。 */
const STOPPING_TOOL_CODES = new Set<PythonAgentRejectionCode>([
  'ATTEMPT_LIMIT',
  'CAPACITY_EXCEEDED',
  'FILE_UNAVAILABLE',
  'IDEMPOTENCY_CONFLICT',
  'UNAUTHORIZED',
  'WORKER_ERROR',
  'EXECUTOR_UNAVAILABLE',
]);

export type PythonAgentInputFile = {
  fileId: string;
  mountName: string;
  displayName: string;
  sizeBytes: number;
};

export type PythonRunCall = {
  protocol: typeof PYTHON_EXECUTOR_PROTOCOL_ID;
  task_id: string;
  idempotency_key: string;
  attempt: number;
  code: string;
  input_files: Array<{ file_id: string; mount_name: string }>;
  profile: PythonRunProfile;
  timeout_seconds: number;
};

export type PythonRunArtifact = {
  artifactId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

export type PythonRunObservation = {
  runId: string;
  attempt: number;
  profile: PythonRunProfile;
  status: PythonRunStatus;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  cleanupStatus: 'pending' | 'succeeded' | 'failed';
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  artifacts: PythonRunArtifact[];
  error: {
    code: PythonRunErrorCode;
    message: string;
    retryable: boolean;
    fingerprint: string;
  } | null;
  metrics: {
    queuedMs: number | null;
    durationMs: number | null;
    cpuTimeMs: number | null;
    peakMemoryBytes: number | null;
  };
  limits: {
    timeoutSeconds: number;
    cpuCount: number;
    memoryBytes: number;
    processes: number;
    stdoutBytes: number;
    stderrBytes: number;
  };
};

export type PythonAgentToolOutcome =
  | { kind: 'result'; observation: PythonRunObservation }
  | {
      kind: 'rejected';
      code: PythonAgentRejectionCode;
      message: string;
      retryable: boolean;
    };

export type PythonAgentCallRejection = {
  code:
    | 'INVALID_REQUEST'
    | 'FILE_UNAVAILABLE'
    | 'IDEMPOTENCY_CONFLICT'
    | 'ATTEMPT_LIMIT';
  message: string;
};

export type PythonAgentCallContext = {
  taskId: string;
  inputs: ReadonlyArray<PythonAgentInputFile>;
  nextAttempt: number;
  /** 已用过的幂等键 → 它对应的 attempt。 */
  idempotencyKeys: ReadonlyMap<string, number>;
};

export type PythonAgentMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls: ChatToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export type PythonAgentTurn = (input: {
  messages: PythonAgentMessage[];
  tools: ChatToolDefinition[];
  toolChoice: 'auto' | 'none';
}) => Promise<
  | { ok: true; text: string | null; toolCalls: ChatToolCall[]; model: string }
  | { ok: false; code: string; error: string }
>;

export type PythonAgentStopReason =
  | 'no_python_needed'
  | 'succeeded'
  | 'attempt_limit'
  | 'non_retryable_failure'
  | 'repeated_fingerprint'
  | 'cleanup_failed'
  | 'tool_rejected'
  /** 运行失败但仍可修复时，模型自己选择不再重试。 */
  | 'agent_stopped'
  | 'model_turn_limit'
  | 'llm_error';

export type PythonAgentRunSummary = {
  runId: string;
  attempt: number;
  profile: PythonRunProfile;
  status: PythonRunStatus;
  exitCode: number | null;
  errorCode: string | null;
  retryable: boolean | null;
  artifactNames: string[];
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  cleanupStatus: string;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type PythonAgentTaskResult = {
  reply: string;
  replySource: 'model' | 'fallback' | 'guard';
  replyViolations: string[];
  attempts: number;
  usedPython: boolean;
  succeeded: boolean;
  stopReason: PythonAgentStopReason;
  rejection: { code: string; message: string; action: string } | null;
  llmError: { code: string; message: string } | null;
  runs: PythonRunObservation[];
  artifacts: PythonRunArtifact[];
  lastError: { code: string; message: string; retryable: boolean } | null;
  model: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLowerCase();
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * 校验模型提交的 `run_python` 参数。
 *
 * 与执行器不同，这里多一层「授权」判断：task_id 必须等于注入值，file_id 必须在
 * 本次任务已授权的清单内，attempt 必须是下一个可用次数。任何越权或伪造都在
 * 入队前拒绝，不消耗真实尝试。
 */
export function validateRunPythonCall(
  value: unknown,
  context: PythonAgentCallContext,
):
  | { ok: true; call: PythonRunCall }
  | { ok: false; rejection: PythonAgentCallRejection } {
  const reject = (
    code: PythonAgentCallRejection['code'],
    message: string,
  ): { ok: false; rejection: PythonAgentCallRejection } => ({
    ok: false,
    rejection: { code, message },
  });

  if (!isRecord(value)) {
    return reject('INVALID_REQUEST', 'run_python 参数必须是 JSON 对象。');
  }
  const allowedKeys = new Set([
    'protocol',
    'task_id',
    'idempotency_key',
    'attempt',
    'code',
    'input_files',
    'profile',
    'timeout_seconds',
  ]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    return reject(
      'INVALID_REQUEST',
      `run_python 不接受这些字段：${unknownKeys.join('、')}。`,
    );
  }
  if (value.protocol !== PYTHON_EXECUTOR_PROTOCOL_ID) {
    return reject(
      'INVALID_REQUEST',
      `protocol 必须精确为 ${PYTHON_EXECUTOR_PROTOCOL_ID}。`,
    );
  }
  if (typeof value.task_id !== 'string' || value.task_id !== context.taskId) {
    return reject('INVALID_REQUEST', 'task_id 必须使用本次任务注入的值。');
  }
  if (context.nextAttempt > PYTHON_AGENT_MAX_ATTEMPTS) {
    return reject(
      'ATTEMPT_LIMIT',
      `这个任务已经用完 ${PYTHON_AGENT_MAX_ATTEMPTS} 次 Python 尝试。`,
    );
  }
  if (value.attempt !== context.nextAttempt) {
    return reject(
      'INVALID_REQUEST',
      `attempt 必须等于 ${context.nextAttempt}（第几次尝试由 Orchestrator 决定）。`,
    );
  }
  if (
    typeof value.idempotency_key !== 'string' ||
    !IDEMPOTENCY_KEY_PATTERN.test(value.idempotency_key)
  ) {
    return reject(
      'INVALID_REQUEST',
      'idempotency_key 必须是 1–128 位的字母、数字、点、下划线、冒号或连字符。',
    );
  }
  const keyOwner = context.idempotencyKeys.get(value.idempotency_key);
  if (keyOwner !== undefined && keyOwner !== context.nextAttempt) {
    return reject(
      'IDEMPOTENCY_CONFLICT',
      '这个 idempotency_key 已经用于其他尝试，请为新的代码尝试使用新的 key。',
    );
  }
  if (typeof value.code !== 'string' || value.code.trim().length === 0) {
    return reject('INVALID_REQUEST', 'code 不能为空。');
  }
  if (byteLength(value.code) > PYTHON_CODE_MAX_BYTES) {
    return reject(
      'INVALID_REQUEST',
      `code 不能超过 ${PYTHON_CODE_MAX_BYTES} 字节。`,
    );
  }
  if (!Array.isArray(value.input_files)) {
    return reject('INVALID_REQUEST', 'input_files 必须是数组。');
  }
  if (value.input_files.length > PYTHON_AGENT_MAX_INPUT_FILES) {
    return reject(
      'INVALID_REQUEST',
      `input_files 最多 ${PYTHON_AGENT_MAX_INPUT_FILES} 个文件。`,
    );
  }

  const byFileId = new Map(context.inputs.map((file) => [file.fileId, file]));
  const seenFileIds = new Set<string>();
  const seenMountNames = new Set<string>();
  const inputFiles: Array<{ file_id: string; mount_name: string }> = [];

  for (const [index, candidate] of value.input_files.entries()) {
    if (!isRecord(candidate)) {
      return reject('INVALID_REQUEST', `input_files[${index}] 必须是对象。`);
    }
    const candidateKeys = Object.keys(candidate);
    if (
      candidateKeys.some((key) => key !== 'file_id' && key !== 'mount_name')
    ) {
      return reject(
        'INVALID_REQUEST',
        `input_files[${index}] 只允许 file_id 和 mount_name。`,
      );
    }
    const fileId = candidate.file_id;
    const mountName = candidate.mount_name;
    if (typeof fileId !== 'string' || !PYTHON_FILE_ID_PATTERN.test(fileId)) {
      return reject(
        'INVALID_REQUEST',
        `input_files[${index}].file_id 格式无效。`,
      );
    }
    if (
      typeof mountName !== 'string' ||
      !PYTHON_MOUNT_NAME_PATTERN.test(mountName) ||
      !INPUT_EXTENSIONS.has(extensionOf(mountName))
    ) {
      return reject(
        'INVALID_REQUEST',
        `input_files[${index}].mount_name 必须是 .csv、.json 或 .txt 的单层安全文件名。`,
      );
    }
    const authorized = byFileId.get(fileId);
    if (!authorized) {
      // 与执行器一致：不存在和越权都回同一个错误，避免探测别的任务。
      return reject(
        'FILE_UNAVAILABLE',
        `input_files[${index}].file_id 不在本次任务已授权的文件里。`,
      );
    }
    if (authorized.mountName !== mountName) {
      return reject(
        'INVALID_REQUEST',
        `input_files[${index}].mount_name 必须是 ${authorized.mountName}。`,
      );
    }
    if (
      seenFileIds.has(fileId) ||
      seenMountNames.has(mountName.toLowerCase())
    ) {
      return reject(
        'INVALID_REQUEST',
        'input_files 里不能有重复文件或重名映射。',
      );
    }
    seenFileIds.add(fileId);
    seenMountNames.add(mountName.toLowerCase());
    inputFiles.push({ file_id: fileId, mount_name: mountName });
  }

  const profile = value.profile ?? 'short';
  if (profile !== 'short' && profile !== 'long') {
    return reject('INVALID_REQUEST', 'profile 必须是 short 或 long。');
  }
  const timeoutMaximum = PYTHON_PROFILE_LIMITS[profile];
  const timeoutSeconds = value.timeout_seconds ?? timeoutMaximum;
  if (
    !Number.isInteger(timeoutSeconds) ||
    (timeoutSeconds as number) < 1 ||
    (timeoutSeconds as number) > timeoutMaximum
  ) {
    return reject(
      'INVALID_REQUEST',
      `timeout_seconds 必须是 1–${timeoutMaximum} 的整数（${profile} 档）。`,
    );
  }

  return {
    ok: true,
    call: {
      protocol: PYTHON_EXECUTOR_PROTOCOL_ID,
      task_id: context.taskId,
      idempotency_key: value.idempotency_key,
      attempt: context.nextAttempt,
      code: value.code,
      input_files: inputFiles,
      profile,
      timeout_seconds: timeoutSeconds as number,
    },
  };
}

const RUN_STATUSES = new Set<PythonRunStatus>([
  'queued',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'killed',
]);
const RUN_ERROR_CODES = new Set<PythonRunErrorCode>([
  'PROCESS_EXIT_NONZERO',
  'WORKER_ERROR',
  'TIMEOUT',
  'MEMORY_LIMIT',
  'PROCESS_LIMIT',
  'POLICY_VIOLATION',
  'CANCELLED',
  'ARTIFACT_REJECTED',
]);

function readNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 把执行器返回的 JSON 收敛成白名单结构。
 *
 * 任何字段缺失、类型不对或状态未知都返回 null：调用方必须把它当成「拿不到可靠结果」
 * 而不是硬猜成成功。
 */
export function readPythonRunObservation(
  value: unknown,
): PythonRunObservation | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (
    typeof status !== 'string' ||
    !RUN_STATUSES.has(status as PythonRunStatus)
  ) {
    return null;
  }
  const runId = value.run_id;
  const attempt = value.attempt;
  if (typeof runId !== 'string' || !Number.isInteger(attempt)) return null;
  const profile = value.profile ?? 'short';
  if (profile !== 'short' && profile !== 'long') return null;

  const rawError = value.error;
  let error: PythonRunObservation['error'] = null;
  if (rawError !== null && rawError !== undefined) {
    if (!isRecord(rawError)) return null;
    const code = rawError.code;
    if (
      typeof code !== 'string' ||
      !RUN_ERROR_CODES.has(code as PythonRunErrorCode)
    ) {
      return null;
    }
    error = {
      code: code as PythonRunErrorCode,
      message: typeof rawError.message === 'string' ? rawError.message : '',
      retryable: rawError.retryable === true,
      fingerprint:
        typeof rawError.error_fingerprint === 'string'
          ? rawError.error_fingerprint
          : '',
    };
  }

  const artifacts: PythonRunArtifact[] = [];
  if (Array.isArray(value.artifacts)) {
    for (const candidate of value.artifacts) {
      if (!isRecord(candidate)) return null;
      if (
        typeof candidate.artifact_id !== 'string' ||
        typeof candidate.name !== 'string' ||
        typeof candidate.mime_type !== 'string'
      ) {
        return null;
      }
      artifacts.push({
        artifactId: candidate.artifact_id,
        name: candidate.name,
        mimeType: candidate.mime_type,
        sizeBytes: readNumberOrNull(candidate.size_bytes) ?? 0,
      });
    }
  } else {
    return null;
  }

  const metrics = isRecord(value.metrics) ? value.metrics : {};
  const limits = isRecord(value.limits) ? value.limits : {};
  const cleanupStatus = value.cleanup_status;
  if (
    cleanupStatus !== 'pending' &&
    cleanupStatus !== 'succeeded' &&
    cleanupStatus !== 'failed'
  ) {
    return null;
  }

  return {
    runId,
    attempt: attempt as number,
    profile,
    status: status as PythonRunStatus,
    exitCode: readNumberOrNull(value.exit_code),
    stdout: typeof value.stdout === 'string' ? value.stdout : null,
    stderr: typeof value.stderr === 'string' ? value.stderr : null,
    stdoutTruncated: value.stdout_truncated === true,
    stderrTruncated: value.stderr_truncated === true,
    cleanupStatus,
    createdAt: typeof value.created_at === 'string' ? value.created_at : null,
    startedAt: typeof value.started_at === 'string' ? value.started_at : null,
    finishedAt:
      typeof value.finished_at === 'string' ? value.finished_at : null,
    artifacts,
    error,
    metrics: {
      queuedMs: readNumberOrNull(metrics.queued_ms),
      durationMs: readNumberOrNull(metrics.duration_ms),
      cpuTimeMs: readNumberOrNull(metrics.cpu_time_ms),
      peakMemoryBytes: readNumberOrNull(metrics.peak_memory_bytes),
    },
    limits: {
      timeoutSeconds: readNumberOrNull(limits.timeout_seconds) ?? 0,
      cpuCount: readNumberOrNull(limits.cpu_count) ?? 0,
      memoryBytes: readNumberOrNull(limits.memory_bytes) ?? 0,
      processes: readNumberOrNull(limits.processes) ?? 0,
      stdoutBytes: readNumberOrNull(limits.stdout_bytes) ?? 0,
      stderrBytes: readNumberOrNull(limits.stderr_bytes) ?? 0,
    },
  };
}

/** 喂给模型的结构化结果：只保留协议字段，不含任何内部路径或凭据。 */
export function toolResultPayload(
  observation: PythonRunObservation,
): Record<string, unknown> {
  return {
    protocol: PYTHON_EXECUTOR_PROTOCOL_ID,
    task_id: null,
    run_id: observation.runId,
    attempt: observation.attempt,
    profile: observation.profile,
    status: observation.status,
    exit_code: observation.exitCode,
    stdout: observation.stdout,
    stderr: observation.stderr,
    stdout_truncated: observation.stdoutTruncated,
    stderr_truncated: observation.stderrTruncated,
    artifacts: observation.artifacts.map((artifact) => ({
      artifact_id: artifact.artifactId,
      name: artifact.name,
      mime_type: artifact.mimeType,
      size_bytes: artifact.sizeBytes,
    })),
    error: observation.error
      ? {
          code: observation.error.code,
          message: observation.error.message,
          retryable: observation.error.retryable,
          error_fingerprint: observation.error.fingerprint,
        }
      : null,
    metrics: {
      queued_ms: observation.metrics.queuedMs,
      duration_ms: observation.metrics.durationMs,
      cpu_time_ms: observation.metrics.cpuTimeMs,
      peak_memory_bytes: observation.metrics.peakMemoryBytes,
    },
    limits: {
      timeout_seconds: observation.limits.timeoutSeconds,
      cpu_count: observation.limits.cpuCount,
      memory_bytes: observation.limits.memoryBytes,
      processes: observation.limits.processes,
      stdout_bytes: observation.limits.stdoutBytes,
      stderr_bytes: observation.limits.stderrBytes,
    },
    cleanup_status: observation.cleanupStatus,
    created_at: observation.createdAt,
    started_at: observation.startedAt,
    finished_at: observation.finishedAt,
    note: '下载入口由页面提供；不要在回答里拼链接、暴露内部路径或对象存储键。',
  };
}

/** 入队前拒绝用的精简错误信封，形状与工具协议一致。 */
export function callRejectionEnvelope(
  rejection: PythonAgentCallRejection,
): Record<string, unknown> {
  return {
    protocol: PYTHON_EXECUTOR_PROTOCOL_ID,
    task_id: null,
    run_id: null,
    status: null,
    error: {
      code: rejection.code,
      message: rejection.message,
      retryable: false,
    },
  };
}

function describeLastRun(observation: PythonRunObservation): string {
  const code = observation.error?.code ?? null;
  switch (code) {
    case 'TIMEOUT':
      return `在 ${observation.limits.timeoutSeconds || 30} 秒墙钟上限内被终止`;
    case 'MEMORY_LIMIT':
      return '因超出内存上限被终止';
    case 'PROCESS_LIMIT':
      return '因进程数超出上限被终止';
    case 'POLICY_VIOLATION':
      return '因策略限制被终止';
    case 'CANCELLED':
      return '被取消';
    case 'WORKER_ERROR':
      return '执行基础设施失败，没有拿到可靠的退出码';
    case 'ARTIFACT_REJECTED':
      return '退出码为 0，但产物没有通过校验，所以本次没有发布任何文件';
    case 'PROCESS_EXIT_NONZERO':
      return `以非零退出码 ${observation.exitCode ?? '未知'} 结束`;
    default:
      return `以状态 ${observation.status} 结束`;
  }
}

function fallbackFailureText(options: {
  attempts: number;
  lastRun: PythonRunObservation | null;
  stopReason: PythonAgentStopReason;
  rejection: PythonAgentTaskResult['rejection'];
  llmError: PythonAgentTaskResult['llmError'];
  modelTurns: number;
}): string {
  const { attempts, lastRun, stopReason, rejection, llmError } = options;

  if (llmError && attempts === 0) {
    return `这次没有运行 Python：模型服务调用失败（${llmError.code}）。没有把未执行的代码当成结果。建议：检查模型 Key 或换一个模型后重试。`;
  }
  if (rejection && attempts === 0) {
    return `这次没有运行 Python。工具返回 ${rejection.code}：${rejection.message} 建议：${rejection.action}`;
  }
  if (!lastRun) {
    return `这次没有完成：模型在 ${options.modelTurns} 轮内没有提交 run_python 调用，也没有给出可用结论。没有把未执行的代码当成结果。建议：换一个模型或把任务拆小后重试。`;
  }

  const code = lastRun.error?.code ?? 'UNKNOWN';
  const explanation = (lastRun.error?.message ?? '执行没有成功').replace(
    /[.\s]+$/,
    '',
  );
  const truncation =
    lastRun.stdoutTruncated || lastRun.stderrTruncated
      ? '日志有截断，只能看到前 1 MiB。'
      : '';
  const nextStep =
    stopReason === 'repeated_fingerprint'
      ? '同一个错误连续出现两次已停止重试，请根据上面的错误信息调整任务或数据后重新提交。'
      : stopReason === 'attempt_limit'
        ? '三次尝试已用完，请修正上游数据或把任务拆小后重新提交。'
        : rejection
          ? rejection.action
          : RETRYABLE_RUN_CODES.has(code as PythonRunErrorCode)
            ? '请根据上面的错误信息修正输入或代码后重新提交。'
            : '这次停止不是代码可以修复的问题，请稍后重试或联系管理员。';

  return [
    `这次没有成功完成。已执行 ${attempts} 次，最后状态为 ${lastRun.status}，错误为 ${code}：${explanation}。`,
    `最后一次运行${describeLastRun(lastRun)}；没有把未成功的代码当成结果。`,
    truncation,
    `建议：${nextStep}`,
  ]
    .filter(Boolean)
    .join('');
}

function fallbackSuccessText(options: {
  attempts: number;
  artifacts: PythonRunArtifact[];
  truncated: boolean;
}): string {
  const files = options.artifacts.length
    ? `生成文件：${options.artifacts.map((artifact) => artifact.name).join('、')}（下载入口见页面）。`
    : '本次没有回收任何产物文件。';
  const truncation = options.truncated ? '日志有截断，只保留了前 1 MiB。' : '';
  return `已完成。运行了本次任务提交的 Python 代码，共执行 ${options.attempts} 次。${files}${truncation}`;
}

const ALWAYS_BANNED_PHRASES: Array<[RegExp, string]> = [
  [/应该已经生成/, '“应该已经生成”属于未经工具结果证明的措辞。'],
  [/看起来(?:成功|已经|没问题)/, '“看起来成功”属于未经工具结果证明的措辞。'],
  [/代码没问题/, '“代码没问题”属于未经工具结果证明的措辞。'],
];
const SUCCESS_CLAIMS = /(?:已完成|已成功|成功执行|执行成功|运行成功|已经成功)/;
const FILE_CLAIMS = /(?:已生成|生成文件|已保存|文件已生成)/;

/**
 * 回答诚实性检查。
 *
 * 结构化结果由执行器给出，模型只负责叙述；这里挡住「没成功却写成成功」和
 * 「没有 artifact 却说生成了文件」两类叙述。没有跑过 Python 的纯问答不做
 * 成功措辞拦截，避免误伤直接回答。
 */
export function findReplyViolations(
  text: string,
  facts: { usedPython: boolean; successfulRuns: number; artifactCount: number },
): string[] {
  const violations: string[] = [];
  for (const [pattern, reason] of ALWAYS_BANNED_PHRASES) {
    if (pattern.test(text)) violations.push(reason);
  }
  if (
    facts.usedPython &&
    facts.successfulRuns === 0 &&
    SUCCESS_CLAIMS.test(text)
  ) {
    violations.push('这次没有成功的 Python 运行，不能声称已完成或已成功执行。');
  }
  if (facts.usedPython && facts.artifactCount === 0 && FILE_CLAIMS.test(text)) {
    violations.push('这次没有回收任何产物文件，不能声称已生成文件。');
  }
  return violations;
}

export function summarizeRun(
  observation: PythonRunObservation,
): PythonAgentRunSummary {
  return {
    runId: observation.runId,
    attempt: observation.attempt,
    profile: observation.profile,
    status: observation.status,
    exitCode: observation.exitCode,
    errorCode: observation.error?.code ?? null,
    retryable: observation.error?.retryable ?? null,
    artifactNames: observation.artifacts.map((artifact) => artifact.name),
    stdoutTruncated: observation.stdoutTruncated,
    stderrTruncated: observation.stderrTruncated,
    cleanupStatus: observation.cleanupStatus,
    createdAt: observation.createdAt,
    startedAt: observation.startedAt,
    finishedAt: observation.finishedAt,
  };
}

type RunDecision = {
  stopReason: PythonAgentStopReason | null;
  /** 停止时是否还要再给模型一次「只写最终回答」的回合。 */
  finalOnly: boolean;
};

/** 单次运行结束后的推进规则：能修就修，不能修就停。 */
export function decideAfterRun(options: {
  observation: PythonRunObservation;
  attemptsUsed: number;
  previousFingerprint: string | null;
}): RunDecision {
  const { observation, attemptsUsed, previousFingerprint } = options;
  if (observation.cleanupStatus !== 'succeeded') {
    return { stopReason: 'cleanup_failed', finalOnly: true };
  }
  if (observation.status === 'queued' || observation.status === 'running') {
    return { stopReason: 'non_retryable_failure', finalOnly: true };
  }
  if (
    observation.status === 'succeeded' &&
    observation.exitCode === 0 &&
    !observation.error
  ) {
    return { stopReason: 'succeeded', finalOnly: true };
  }
  const error = observation.error;
  if (
    !error ||
    error.retryable !== true ||
    !RETRYABLE_RUN_CODES.has(error.code)
  ) {
    return { stopReason: 'non_retryable_failure', finalOnly: true };
  }
  if (
    error.fingerprint &&
    previousFingerprint &&
    error.fingerprint === previousFingerprint
  ) {
    return { stopReason: 'repeated_fingerprint', finalOnly: true };
  }
  if (attemptsUsed >= PYTHON_AGENT_MAX_ATTEMPTS) {
    return { stopReason: 'attempt_limit', finalOnly: true };
  }
  return { stopReason: null, finalOnly: false };
}

/**
 * 驱动一次完整的 Agent 任务：最多 3 次 Python 尝试、最多 6 个模型回合。
 *
 * 返回的 `reply` 永远不会把失败说成成功：模型文本通过诚实性检查，检查不过或
 * 模型没能收尾时，用确定性模板兜底。
 */
export async function runPythonAgentTask(options: {
  taskId: string;
  task: string;
  inputs: ReadonlyArray<PythonAgentInputFile>;
  artifactsAllowed: boolean;
  requireArtifact?: boolean;
  /** 同一个使用端会话里更早的对话轮次；只作上下文，不是工具结果。 */
  history?: ReadonlyArray<ChatMessage>;
  /** 由服务端已发布工作流注入，不能从请求正文读取。 */
  workflowConstraints?: string;
  turn: PythonAgentTurn;
  execute: (call: PythonRunCall) => Promise<PythonAgentToolOutcome>;
  maxModelTurns?: number;
}): Promise<PythonAgentTaskResult> {
  const maxModelTurns = options.maxModelTurns ?? PYTHON_AGENT_MAX_MODEL_TURNS;
  const history: PythonAgentMessage[] = (options.history ?? [])
    .filter((message) => message.content.trim().length > 0)
    .map((message) =>
      message.role === 'assistant'
        ? { role: 'assistant', content: message.content, toolCalls: [] }
        : { role: 'user', content: message.content },
    );
  const messages: PythonAgentMessage[] = [
    {
      role: 'system',
      content: [
        buildPythonAgentSystemPrompt({
          taskId: options.taskId,
          artifactsAllowed: options.artifactsAllowed,
          inputs: options.inputs,
          previousAttempts: [],
          hasConversationHistory: history.length > 0,
        }),
        options.workflowConstraints,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
    ...history,
    { role: 'user', content: options.task },
  ];

  const runs: PythonRunObservation[] = [];
  const idempotencyKeys = new Map<string, number>();
  let toolChoice: 'auto' | 'none' = 'auto';
  let stopReason: PythonAgentStopReason | null = null;
  let rejection: PythonAgentTaskResult['rejection'] = null;
  let llmError: PythonAgentTaskResult['llmError'] = null;
  let model: string | null = null;
  let reply: string | null = null;
  let previousFingerprint: string | null = null;
  let turnsUsed = 0;

  for (let turnIndex = 0; turnIndex < maxModelTurns; turnIndex += 1) {
    turnsUsed = turnIndex + 1;
    const tools = toolChoice === 'auto' ? [PYTHON_AGENT_TOOL] : [];
    const turnResult = await options.turn({
      messages: [...messages],
      tools,
      toolChoice,
    });

    if (!turnResult.ok) {
      stopReason = 'llm_error';
      llmError = { code: turnResult.code, message: turnResult.error };
      break;
    }
    model = turnResult.model;

    if (turnResult.toolCalls.length === 0) {
      const text = turnResult.text?.trim() ?? '';
      if (text) {
        if (
          options.requireArtifact &&
          options.artifactsAllowed &&
          runs.length === 0 &&
          toolChoice === 'auto'
        ) {
          messages.push({
            role: 'assistant',
            content: text,
            toolCalls: [],
          });
          messages.push({
            role: 'user',
            content:
              '（Orchestrator 提示：用户明确要求生成可下载文件。必须现在调用 run_python 实际生成 output/ 产物，不要只返回命令、代码或安装步骤。）',
          });
          continue;
        }
        reply = text;
        stopReason ??=
          runs.length > 0
            ? 'agent_stopped'
            : rejection
              ? 'tool_rejected'
              : 'no_python_needed';
        break;
      }
      messages.push({
        role: 'user',
        content:
          '（Orchestrator 提示：上一轮没有返回任何内容或工具调用。请给出最终回答，或在需要时提交一次 run_python 调用。）',
      });
      continue;
    }

    // 一轮只接受一个工具调用：多个调用不在这里并行执行。
    const [call] = turnResult.toolCalls;
    const rejectedExtra = turnResult.toolCalls.length > 1;
    messages.push({
      role: 'assistant',
      content: turnResult.text,
      toolCalls: turnResult.toolCalls,
    });
    const replyToModel = (content: string) => {
      for (const toolCall of turnResult.toolCalls) {
        messages.push({
          role: 'tool',
          toolCallId: toolCall.id,
          content:
            toolCall === call
              ? content
              : JSON.stringify({
                  error: {
                    code: 'INVALID_REQUEST',
                    message: '一轮只接受一个 run_python 调用，请分开提交。',
                  },
                }),
        });
      }
    };

    if (rejectedExtra) {
      replyToModel(
        JSON.stringify({
          error: {
            code: 'INVALID_REQUEST',
            message: '一轮只接受一个 run_python 调用，请分开提交。',
          },
        }),
      );
      continue;
    }

    if (toolChoice === 'none') {
      // 已经进入「只写最终回答」阶段：不再接受新的执行请求。
      replyToModel(
        JSON.stringify({
          error: {
            code: 'ATTEMPT_LIMIT',
            message:
              '这次任务已经停止执行新的 Python 尝试，请直接按上面的结构化结果给出最终回答。',
          },
        }),
      );
      continue;
    }

    if (call.name !== PYTHON_AGENT_TOOL_NAME) {
      replyToModel(
        JSON.stringify({
          error: {
            code: 'INVALID_REQUEST',
            message: `未知工具 ${call.name}；本次任务唯一可用的工具是 ${PYTHON_AGENT_TOOL_NAME}。`,
          },
        }),
      );
      continue;
    }

    let submitted: unknown;
    try {
      submitted = JSON.parse(call.arguments);
    } catch {
      replyToModel(
        JSON.stringify({
          error: {
            code: 'INVALID_REQUEST',
            message: 'run_python 参数必须是合法 JSON 对象。',
          },
        }),
      );
      continue;
    }

    const validated = validateRunPythonCall(submitted, {
      taskId: options.taskId,
      inputs: options.inputs,
      nextAttempt: runs.length + 1,
      idempotencyKeys,
    });
    if (!validated.ok) {
      replyToModel(JSON.stringify(callRejectionEnvelope(validated.rejection)));
      rejection = {
        code: validated.rejection.code,
        message: validated.rejection.message,
        action: REJECTION_ACTIONS[validated.rejection.code],
      };
      if (STOPPING_TOOL_CODES.has(validated.rejection.code)) {
        stopReason = 'tool_rejected';
        toolChoice = 'none';
      }
      continue;
    }

    idempotencyKeys.set(validated.call.idempotency_key, validated.call.attempt);
    const outcome = await options.execute(validated.call);

    if (outcome.kind === 'rejected') {
      replyToModel(
        JSON.stringify({
          protocol: PYTHON_EXECUTOR_PROTOCOL_ID,
          task_id: validated.call.task_id,
          run_id: null,
          status: null,
          error: {
            code: outcome.code,
            message: outcome.message,
            retryable: outcome.retryable,
          },
        }),
      );
      stopReason = 'tool_rejected';
      rejection = {
        code: outcome.code,
        message: outcome.message,
        action: REJECTION_ACTIONS[outcome.code],
      };
      toolChoice = 'none';
      continue;
    }

    const observation = outcome.observation;
    runs.push(observation);
    replyToModel(JSON.stringify(toolResultPayload(observation)));

    const decision = decideAfterRun({
      observation,
      attemptsUsed: runs.length,
      previousFingerprint,
    });
    previousFingerprint = observation.error?.fingerprint ?? null;
    if (decision.stopReason) {
      stopReason = decision.stopReason;
      if (decision.finalOnly) toolChoice = 'none';
    }
  }

  const successfulRuns = runs.filter(
    (run) =>
      run.status === 'succeeded' &&
      run.exitCode === 0 &&
      !run.error &&
      run.cleanupStatus === 'succeeded',
  );
  const artifacts = runs.flatMap((run) => run.artifacts);
  const lastRun = runs.at(-1) ?? null;
  const usedPython = runs.length > 0;
  const succeeded = successfulRuns.length > 0;
  const finalStopReason: PythonAgentStopReason =
    stopReason ?? 'model_turn_limit';

  let replySource: PythonAgentTaskResult['replySource'] = 'model';
  let finalReply = reply ?? '';
  if (!finalReply) {
    replySource = 'fallback';
    finalReply = succeeded
      ? fallbackSuccessText({
          attempts: runs.length,
          artifacts,
          truncated: runs.some(
            (run) => run.stdoutTruncated || run.stderrTruncated,
          ),
        })
      : fallbackFailureText({
          attempts: runs.length,
          lastRun,
          stopReason: finalStopReason,
          rejection,
          llmError,
          modelTurns: turnsUsed,
        });
  }

  const violations = findReplyViolations(finalReply, {
    usedPython,
    successfulRuns: successfulRuns.length,
    artifactCount: artifacts.length,
  });
  if (violations.length > 0) {
    // 叙述与事实冲突时不发布这段叙述，改用确定性模板。
    finalReply = succeeded
      ? fallbackSuccessText({
          attempts: runs.length,
          artifacts,
          truncated: runs.some(
            (run) => run.stdoutTruncated || run.stderrTruncated,
          ),
        })
      : fallbackFailureText({
          attempts: runs.length,
          lastRun,
          stopReason: finalStopReason,
          rejection,
          llmError,
          modelTurns: turnsUsed,
        });
    replySource = 'guard';
  }

  return {
    reply: finalReply,
    replySource,
    replyViolations: violations,
    attempts: runs.length,
    usedPython,
    succeeded,
    stopReason: finalStopReason,
    rejection,
    llmError,
    runs,
    artifacts,
    lastError: lastRun?.error
      ? {
          code: lastRun.error.code,
          message: lastRun.error.message,
          retryable: lastRun.error.retryable,
        }
      : null,
    model,
  };
}
