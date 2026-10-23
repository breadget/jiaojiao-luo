export const LOCAL_CONTROL_PROTOCOL = 'urtoris.local-control.v1' as const;

export const LOCAL_CONTROL_TASK_ID_PATTERN = /^localtask_[a-f0-9]{32}$/;
export const LOCAL_CONTROL_RUN_ID_PATTERN = /^shell_[a-f0-9]{32}$/;
export const LOCAL_CONTROL_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const LOCAL_CONTROL_LIMITS = Object.freeze({
  commandBytes: 64 * 1024,
  cwdBytes: 4 * 1024,
  reasonBytes: 2 * 1024,
  requestBytes: 128 * 1024,
  stdoutBytes: 1024 * 1024,
  stderrBytes: 1024 * 1024,
  defaultTimeoutSeconds: 60 * 60,
  maximumTimeoutSeconds: 24 * 60 * 60,
  /**
   * How long to keep draining stdout/stderr after the shell itself exited.
   *
   * A command that leaves a background process holding the pipe open never
   * emits `close`; waiting forever would pin the single concurrency slot until
   * the command timeout, so the run is finalised with the output captured so
   * far.
   */
  stdioGraceMilliseconds: 2_000,
});

export type LocalControlRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export type LocalControlErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'CAPACITY_EXCEEDED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RUN_UNAVAILABLE'
  | 'SPAWN_FAILED'
  | 'COMMAND_EXIT_NONZERO'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'NODE_RESTARTED'
  | 'WORKER_ERROR';

export type LocalControlSubmission = {
  protocol: typeof LOCAL_CONTROL_PROTOCOL;
  task_id: string;
  idempotency_key: string;
  command: string;
  cwd?: string;
  timeout_seconds?: number;
  reason?: string;
};

export type LocalControlRunObservation = {
  protocol: typeof LOCAL_CONTROL_PROTOCOL;
  task_id: string;
  run_id: string;
  idempotency_key: string;
  status: LocalControlRunStatus;
  command: string;
  cwd: string;
  shell: string;
  timeout_seconds: number;
  reason: string | null;
  pid: number | null;
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  cancellation_requested: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: {
    code: LocalControlErrorCode;
    message: string;
  } | null;
};

export type LocalControlInfo = {
  protocol: typeof LOCAL_CONTROL_PROTOCOL;
  mode: 'local-user-shell';
  username: string;
  uid: number | null;
  hostname: string;
  platform: string;
  shell: string;
  default_cwd: string;
  concurrency: number;
  maximum_timeout_seconds: number;
  started_at: string;
};

const RUN_STATUSES = new Set<LocalControlRunStatus>([
  'queued',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
]);

const ERROR_CODES = new Set<LocalControlErrorCode>([
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'CAPACITY_EXCEEDED',
  'IDEMPOTENCY_CONFLICT',
  'RUN_UNAVAILABLE',
  'SPAWN_FAILED',
  'COMMAND_EXIT_NONZERO',
  'TIMEOUT',
  'CANCELLED',
  'NODE_RESTARTED',
  'WORKER_ERROR',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

/** Parse an executor observation without trusting its transport boundary. */
export function readLocalControlRunObservation(
  value: unknown,
): LocalControlRunObservation | null {
  if (!isObject(value)) return null;
  const errorValue = value.error;
  let error: LocalControlRunObservation['error'];
  if (errorValue === null) {
    error = null;
  } else if (
    isObject(errorValue) &&
    typeof errorValue.code === 'string' &&
    ERROR_CODES.has(errorValue.code as LocalControlErrorCode) &&
    typeof errorValue.message === 'string'
  ) {
    error = {
      code: errorValue.code as LocalControlErrorCode,
      message: errorValue.message,
    };
  } else {
    return null;
  }

  if (
    value.protocol !== LOCAL_CONTROL_PROTOCOL ||
    typeof value.task_id !== 'string' ||
    !LOCAL_CONTROL_TASK_ID_PATTERN.test(value.task_id) ||
    typeof value.run_id !== 'string' ||
    !LOCAL_CONTROL_RUN_ID_PATTERN.test(value.run_id) ||
    typeof value.idempotency_key !== 'string' ||
    !LOCAL_CONTROL_IDEMPOTENCY_KEY_PATTERN.test(value.idempotency_key) ||
    typeof value.status !== 'string' ||
    !RUN_STATUSES.has(value.status as LocalControlRunStatus) ||
    typeof value.command !== 'string' ||
    typeof value.cwd !== 'string' ||
    typeof value.shell !== 'string' ||
    !Number.isInteger(value.timeout_seconds) ||
    (value.timeout_seconds as number) < 1 ||
    (value.timeout_seconds as number) >
      LOCAL_CONTROL_LIMITS.maximumTimeoutSeconds ||
    (value.reason !== null && typeof value.reason !== 'string') ||
    (value.pid !== null &&
      (!Number.isInteger(value.pid) || (value.pid as number) <= 0)) ||
    (value.exit_code !== null && !Number.isInteger(value.exit_code)) ||
    optionalString(value.signal) === undefined ||
    typeof value.stdout !== 'string' ||
    typeof value.stderr !== 'string' ||
    typeof value.stdout_truncated !== 'boolean' ||
    typeof value.stderr_truncated !== 'boolean' ||
    typeof value.cancellation_requested !== 'boolean' ||
    typeof value.created_at !== 'string' ||
    optionalString(value.started_at) === undefined ||
    optionalString(value.finished_at) === undefined
  ) {
    return null;
  }

  return {
    protocol: LOCAL_CONTROL_PROTOCOL,
    task_id: value.task_id,
    run_id: value.run_id,
    idempotency_key: value.idempotency_key,
    status: value.status as LocalControlRunStatus,
    command: value.command,
    cwd: value.cwd,
    shell: value.shell,
    timeout_seconds: value.timeout_seconds as number,
    reason: value.reason as string | null,
    pid: value.pid as number | null,
    exit_code: value.exit_code as number | null,
    signal: value.signal as string | null,
    stdout: value.stdout,
    stderr: value.stderr,
    stdout_truncated: value.stdout_truncated,
    stderr_truncated: value.stderr_truncated,
    cancellation_requested: value.cancellation_requested,
    created_at: value.created_at,
    started_at: value.started_at as string | null,
    finished_at: value.finished_at as string | null,
    error,
  };
}

export function readLocalControlInfo(value: unknown): LocalControlInfo | null {
  if (
    !isObject(value) ||
    value.protocol !== LOCAL_CONTROL_PROTOCOL ||
    value.mode !== 'local-user-shell' ||
    typeof value.username !== 'string' ||
    (value.uid !== null && !Number.isInteger(value.uid)) ||
    typeof value.hostname !== 'string' ||
    typeof value.platform !== 'string' ||
    typeof value.shell !== 'string' ||
    typeof value.default_cwd !== 'string' ||
    !Number.isInteger(value.concurrency) ||
    !Number.isInteger(value.maximum_timeout_seconds) ||
    typeof value.started_at !== 'string'
  ) {
    return null;
  }
  return value as LocalControlInfo;
}
