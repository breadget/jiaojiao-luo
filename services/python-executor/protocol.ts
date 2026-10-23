import { createHash } from 'node:crypto';

export const PYTHON_EXECUTOR_PROTOCOL = 'urtoris.python-executor.v1' as const;

export const EXECUTOR_PROFILES = Object.freeze({
  short: Object.freeze({
    timeoutSeconds: 30,
    memoryBytes: 512 * 1024 * 1024,
    cpuCount: 1,
  }),
  long: Object.freeze({
    timeoutSeconds: 10 * 60,
    memoryBytes: 2 * 1024 * 1024 * 1024,
    cpuCount: 2,
  }),
});

export type PythonRunProfile = keyof typeof EXECUTOR_PROFILES;

export const EXECUTOR_LIMITS = Object.freeze({
  codeBytes: 64 * 1024,
  inputFiles: 10,
  inputFileBytes: 25 * 1024 * 1024,
  inputTotalBytes: 50 * 1024 * 1024,
  /** 兼容旧调用方；新代码应从 EXECUTOR_PROFILES 取资源上限。 */
  timeoutSeconds: EXECUTOR_PROFILES.short.timeoutSeconds,
  memoryBytes: EXECUTOR_PROFILES.short.memoryBytes,
  cpuCount: EXECUTOR_PROFILES.short.cpuCount,
  processes: 64,
  openFiles: 256,
  streamBytes: 1024 * 1024,
  outputVolumeBytes: 128 * 1024 * 1024,
  artifacts: 20,
  artifactFileBytes: 50 * 1024 * 1024,
  artifactTotalBytes: 100 * 1024 * 1024,
  pngPixels: 50_000_000,
});

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FILE_ID_PATTERN = /^file_[a-f0-9]{32}$/;
export const SAFE_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const REQUEST_KEYS = new Set([
  'protocol',
  'task_id',
  'idempotency_key',
  'attempt',
  'code',
  'input_files',
  'profile',
  'timeout_seconds',
]);
const INPUT_FILE_KEYS = new Set(['file_id', 'mount_name']);
const INPUT_EXTENSIONS = new Set([
  '.csv',
  '.json',
  '.txt',
  '.pdf',
  '.doc',
  '.docx',
  '.rtf',
  '.odt',
  '.ppt',
  '.pptx',
  '.odp',
  '.xls',
  '.xlsx',
  '.ods',
  '.png',
  '.jpg',
  '.jpeg',
]);

/** 允许的输入类型 → MIME。文本类按 UTF-8 校验，二进制类按魔数校验。 */
const INPUT_MIME_TYPES: ReadonlyMap<string, string> = new Map([
  ['.csv', 'text/csv'],
  ['.json', 'application/json'],
  ['.txt', 'text/plain'],
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  [
    '.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  ['.rtf', 'application/rtf'],
  ['.odt', 'application/vnd.oasis.opendocument.text'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  [
    '.pptx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  ['.odp', 'application/vnd.oasis.opendocument.presentation'],
  ['.xls', 'application/vnd.ms-excel'],
  [
    '.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
  ['.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
]);

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d];
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const RTF_SIGNATURE = [0x7b, 0x5c, 0x72, 0x74, 0x66];
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

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

export type ToolErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FILE_UNAVAILABLE'
  | 'ATTEMPT_LIMIT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CAPACITY_EXCEEDED';

export type PythonInputFile = {
  file_id: string;
  mount_name: string;
};

export type RunPythonRequest = {
  protocol: typeof PYTHON_EXECUTOR_PROTOCOL;
  task_id: string;
  idempotency_key: string;
  attempt: number;
  code: string;
  input_files: PythonInputFile[];
  profile: PythonRunProfile;
  timeout_seconds: number;
};

export type PythonArtifact = {
  artifact_id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
};

export type PythonRunError = {
  code: PythonRunErrorCode;
  message: string;
  retryable: boolean;
  error_fingerprint: string;
};

export type PythonRunResult = {
  protocol: typeof PYTHON_EXECUTOR_PROTOCOL;
  task_id: string;
  run_id: string;
  attempt: number;
  parent_run_id: string | null;
  profile: PythonRunProfile;
  status: PythonRunStatus;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  artifacts: PythonArtifact[];
  error: PythonRunError | null;
  metrics: {
    queued_ms: number | null;
    duration_ms: number | null;
    cpu_time_ms: number | null;
    peak_memory_bytes: number | null;
  };
  limits: {
    timeout_seconds: number;
    cpu_count: number;
    memory_bytes: number;
    processes: number;
    stdout_bytes: number;
    stderr_bytes: number;
  };
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  cleanup_status: 'pending' | 'succeeded' | 'failed';
};

export type ToolErrorEnvelope = {
  protocol: typeof PYTHON_EXECUTOR_PROTOCOL;
  task_id: string | null;
  run_id: null;
  status: null;
  error: {
    code: ToolErrorCode;
    message: string;
    retryable: boolean;
  };
};

export class ToolRequestError extends Error {
  readonly code: ToolErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly taskId: string | null;

  constructor(
    code: ToolErrorCode,
    message: string,
    options: {
      httpStatus?: number;
      retryable?: boolean;
      taskId?: string | null;
    } = {},
  ) {
    super(message);
    this.name = 'ToolRequestError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? 400;
    this.retryable = options.retryable ?? false;
    this.taskId = options.taskId ?? null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ToolRequestError(
      'INVALID_REQUEST',
      `${label} contains unknown fields: ${unknown.join(', ')}.`,
    );
  }
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLowerCase();
}

export function isSafeTaskId(value: string): boolean {
  return TASK_ID_PATTERN.test(value);
}

export function isSafeFileId(value: string): boolean {
  return FILE_ID_PATTERN.test(value);
}

export function isSafeInputName(value: string): boolean {
  return (
    SAFE_FILE_NAME_PATTERN.test(value) &&
    INPUT_EXTENSIONS.has(extensionOf(value))
  );
}

export function inputMimeType(name: string): string | null {
  return INPUT_MIME_TYPES.get(extensionOf(name)) ?? null;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.byteLength < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

/**
 * 输入字节的类型校验：返回 null 表示通过，否则返回给用户看的说明。
 *
 * 文本类必须是 UTF-8（含 BOM）；办公文档/图片走魔数校验，真正的解析发生在
 * 沙箱里，容器本身就是信任边界。
 */
export function validateInputBytes(
  name: string,
  bytes: Uint8Array,
): string | null {
  const extension = extensionOf(name);
  if (!INPUT_MIME_TYPES.has(extension)) {
    return 'The input file type is not allowed.';
  }
  if (extension === '.csv' || extension === '.json' || extension === '.txt') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return null;
    } catch {
      return 'CSV, JSON, and TXT inputs must be UTF-8 or UTF-8 BOM text.';
    }
  }
  if (extension === '.pdf' && !startsWith(bytes, PDF_SIGNATURE)) {
    return 'PDF inputs must start with a PDF signature.';
  }
  if (extension === '.rtf' && !startsWith(bytes, RTF_SIGNATURE)) {
    return 'RTF inputs must start with an RTF signature.';
  }
  if (
    (extension === '.doc' || extension === '.ppt' || extension === '.xls') &&
    !startsWith(bytes, OLE_SIGNATURE)
  ) {
    return 'Legacy Office inputs must be valid OLE compound documents.';
  }
  if (
    (extension === '.docx' ||
      extension === '.odt' ||
      extension === '.pptx' ||
      extension === '.odp' ||
      extension === '.xlsx' ||
      extension === '.ods') &&
    !startsWith(bytes, ZIP_SIGNATURE)
  ) {
    return 'Modern Office inputs must be valid zip containers.';
  }
  if (extension === '.png' && !startsWith(bytes, PNG_SIGNATURE)) {
    return 'PNG inputs must start with a PNG signature.';
  }
  if (
    (extension === '.jpg' || extension === '.jpeg') &&
    !startsWith(bytes, JPEG_SIGNATURE)
  ) {
    return 'JPEG inputs must start with a JPEG signature.';
  }
  return null;
}

export function validateRunPythonRequest(value: unknown): RunPythonRequest {
  if (!isRecord(value)) {
    throw new ToolRequestError(
      'INVALID_REQUEST',
      'The run request must be a JSON object.',
    );
  }
  rejectUnknownKeys(value, REQUEST_KEYS, 'The run request');

  if (value.protocol !== PYTHON_EXECUTOR_PROTOCOL) {
    throw new ToolRequestError(
      'INVALID_REQUEST',
      `protocol must be ${PYTHON_EXECUTOR_PROTOCOL}.`,
    );
  }
  if (typeof value.task_id !== 'string' || !isSafeTaskId(value.task_id)) {
    throw new ToolRequestError('INVALID_REQUEST', 'task_id is invalid.');
  }
  if (
    typeof value.idempotency_key !== 'string' ||
    !IDEMPOTENCY_PATTERN.test(value.idempotency_key)
  ) {
    throw new ToolRequestError(
      'INVALID_REQUEST',
      'idempotency_key is invalid.',
      { taskId: value.task_id },
    );
  }
  if (
    !Number.isInteger(value.attempt) ||
    (value.attempt as number) < 1 ||
    (value.attempt as number) > 3
  ) {
    throw new ToolRequestError(
      'INVALID_REQUEST',
      'attempt must be an integer from 1 to 3.',
      { taskId: value.task_id },
    );
  }
  if (typeof value.code !== 'string' || value.code.length === 0) {
    throw new ToolRequestError('INVALID_REQUEST', 'code must not be empty.', {
      taskId: value.task_id,
    });
  }
  if (Buffer.byteLength(value.code, 'utf8') > EXECUTOR_LIMITS.codeBytes) {
    throw new ToolRequestError(
      'INVALID_REQUEST',
      `code cannot exceed ${EXECUTOR_LIMITS.codeBytes} bytes.`,
      { taskId: value.task_id },
    );
  }
  if (!Array.isArray(value.input_files)) {
    throw new ToolRequestError(
      'INVALID_REQUEST',
      'input_files must be an array.',
      { taskId: value.task_id },
    );
  }
  if (value.input_files.length > EXECUTOR_LIMITS.inputFiles) {
    throw new ToolRequestError(
      'INVALID_REQUEST',
      `input_files cannot contain more than ${EXECUTOR_LIMITS.inputFiles} files.`,
      { taskId: value.task_id },
    );
  }

  const fileIds = new Set<string>();
  const mountNames = new Set<string>();
  const inputFiles: PythonInputFile[] = value.input_files.map(
    (candidate, index) => {
      if (!isRecord(candidate)) {
        throw new ToolRequestError(
          'INVALID_REQUEST',
          `input_files[${index}] must be an object.`,
          { taskId: value.task_id as string },
        );
      }
      rejectUnknownKeys(candidate, INPUT_FILE_KEYS, `input_files[${index}]`);
      if (
        typeof candidate.file_id !== 'string' ||
        !isSafeFileId(candidate.file_id)
      ) {
        throw new ToolRequestError(
          'INVALID_REQUEST',
          `input_files[${index}].file_id is invalid.`,
          { taskId: value.task_id as string },
        );
      }
      if (
        typeof candidate.mount_name !== 'string' ||
        !isSafeInputName(candidate.mount_name)
      ) {
        throw new ToolRequestError(
          'INVALID_REQUEST',
          `input_files[${index}].mount_name is invalid.`,
          { taskId: value.task_id as string },
        );
      }
      const normalizedName = candidate.mount_name.toLowerCase();
      if (fileIds.has(candidate.file_id) || mountNames.has(normalizedName)) {
        throw new ToolRequestError(
          'INVALID_REQUEST',
          'input_files cannot contain duplicate file IDs or mount names.',
          { taskId: value.task_id as string },
        );
      }
      fileIds.add(candidate.file_id);
      mountNames.add(normalizedName);
      return {
        file_id: candidate.file_id,
        mount_name: candidate.mount_name,
      };
    },
  );

  const profile = value.profile ?? 'short';
  if (profile !== 'short' && profile !== 'long') {
    throw new ToolRequestError(
      'INVALID_REQUEST',
      'profile must be short or long.',
      { taskId: value.task_id },
    );
  }
  const profileLimits = EXECUTOR_PROFILES[profile];
  const timeoutSeconds = value.timeout_seconds ?? profileLimits.timeoutSeconds;
  if (
    !Number.isInteger(timeoutSeconds) ||
    (timeoutSeconds as number) < 1 ||
    (timeoutSeconds as number) > profileLimits.timeoutSeconds
  ) {
    throw new ToolRequestError(
      'INVALID_REQUEST',
      `timeout_seconds must be an integer from 1 to ${profileLimits.timeoutSeconds} for profile ${profile}.`,
      { taskId: value.task_id },
    );
  }

  return {
    protocol: PYTHON_EXECUTOR_PROTOCOL,
    task_id: value.task_id,
    idempotency_key: value.idempotency_key,
    attempt: value.attempt as number,
    code: value.code,
    input_files: inputFiles,
    profile,
    timeout_seconds: timeoutSeconds as number,
  };
}

export function normalizedRequestHash(request: RunPythonRequest): string {
  const normalized = {
    ...request,
    input_files: [...request.input_files].sort((left, right) =>
      left.mount_name.localeCompare(right.mount_name),
    ),
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}

export function errorFingerprint(
  code: PythonRunErrorCode,
  stderr: string,
): string {
  const normalized = stderr
    .replaceAll(/\/workspace\/(?:input|output)\//g, '<workspace>/')
    .replaceAll(/line \d+/gi, 'line <n>')
    .replaceAll(/\b0x[0-9a-f]+\b/gi, '<address>')
    .trim()
    .split('\n')
    .slice(-4)
    .join('\n');
  return `sha256:${createHash('sha256').update(`${code}\n${normalized}`).digest('hex')}`;
}

export function toolErrorEnvelope(error: ToolRequestError): ToolErrorEnvelope {
  return {
    protocol: PYTHON_EXECUTOR_PROTOCOL,
    task_id: error.taskId,
    run_id: null,
    status: null,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  };
}
