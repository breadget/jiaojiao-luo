import { isAbsolute } from 'node:path';
import {
  LOCAL_CONTROL_IDEMPOTENCY_KEY_PATTERN,
  LOCAL_CONTROL_LIMITS,
  LOCAL_CONTROL_PROTOCOL,
  LOCAL_CONTROL_TASK_ID_PATTERN,
  type LocalControlErrorCode,
  type LocalControlSubmission,
} from '../../lib/local-control-protocol';

export class LocalControlRequestError extends Error {
  constructor(
    public readonly code: LocalControlErrorCode,
    message: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'LocalControlRequestError';
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export type ParsedLocalControlSubmission = Required<
  Pick<
    LocalControlSubmission,
    'protocol' | 'task_id' | 'idempotency_key' | 'command'
  >
> & {
  cwd: string;
  timeout_seconds: number;
  reason: string | null;
};

/** Validate the deliberately unrestricted command envelope and its bounds. */
export function parseLocalControlSubmission(
  value: unknown,
  defaultCwd: string,
): ParsedLocalControlSubmission {
  if (!isObject(value)) {
    throw new LocalControlRequestError(
      'INVALID_REQUEST',
      'The run request must be a JSON object.',
    );
  }
  if (value.protocol !== LOCAL_CONTROL_PROTOCOL) {
    throw new LocalControlRequestError(
      'INVALID_REQUEST',
      `protocol must be ${LOCAL_CONTROL_PROTOCOL}.`,
    );
  }

  const taskId = typeof value.task_id === 'string' ? value.task_id.trim() : '';
  if (!LOCAL_CONTROL_TASK_ID_PATTERN.test(taskId)) {
    throw new LocalControlRequestError(
      'INVALID_REQUEST',
      'task_id is invalid.',
    );
  }

  const idempotencyKey =
    typeof value.idempotency_key === 'string'
      ? value.idempotency_key.trim()
      : '';
  if (!LOCAL_CONTROL_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new LocalControlRequestError(
      'INVALID_REQUEST',
      'idempotency_key is invalid.',
    );
  }

  const command = typeof value.command === 'string' ? value.command.trim() : '';
  if (
    !command ||
    command.includes('\0') ||
    byteLength(command) > LOCAL_CONTROL_LIMITS.commandBytes
  ) {
    throw new LocalControlRequestError(
      'INVALID_REQUEST',
      `command must contain 1-${LOCAL_CONTROL_LIMITS.commandBytes} UTF-8 bytes and no NUL bytes.`,
    );
  }

  const cwd =
    value.cwd === undefined
      ? defaultCwd
      : typeof value.cwd === 'string'
        ? value.cwd.trim()
        : '';
  if (
    !cwd ||
    cwd.includes('\0') ||
    !isAbsolute(cwd) ||
    byteLength(cwd) > LOCAL_CONTROL_LIMITS.cwdBytes
  ) {
    throw new LocalControlRequestError(
      'INVALID_REQUEST',
      'cwd must be an absolute path within the configured size limit.',
    );
  }

  const timeout =
    value.timeout_seconds === undefined
      ? LOCAL_CONTROL_LIMITS.defaultTimeoutSeconds
      : value.timeout_seconds;
  if (
    typeof timeout !== 'number' ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > LOCAL_CONTROL_LIMITS.maximumTimeoutSeconds
  ) {
    throw new LocalControlRequestError(
      'INVALID_REQUEST',
      `timeout_seconds must be an integer from 1 to ${LOCAL_CONTROL_LIMITS.maximumTimeoutSeconds}.`,
    );
  }

  const reason =
    value.reason === undefined
      ? null
      : typeof value.reason === 'string'
        ? value.reason.trim()
        : '';
  if (
    reason !== null &&
    (reason.includes('\0') ||
      byteLength(reason) > LOCAL_CONTROL_LIMITS.reasonBytes)
  ) {
    throw new LocalControlRequestError(
      'INVALID_REQUEST',
      `reason cannot exceed ${LOCAL_CONTROL_LIMITS.reasonBytes} UTF-8 bytes.`,
    );
  }

  return {
    protocol: LOCAL_CONTROL_PROTOCOL,
    task_id: taskId,
    idempotency_key: idempotencyKey,
    command,
    cwd,
    timeout_seconds: timeout,
    reason: reason || null,
  };
}

export function localControlErrorEnvelope(cause: LocalControlRequestError) {
  return {
    protocol: LOCAL_CONTROL_PROTOCOL,
    error: {
      code: cause.code,
      message: cause.message,
    },
  };
}
