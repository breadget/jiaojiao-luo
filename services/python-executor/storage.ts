import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  EXECUTOR_LIMITS,
  type PythonRunResult,
  type RunPythonRequest,
  ToolRequestError,
  isSafeFileId,
  isSafeInputName,
  isSafeTaskId,
} from './protocol';

export type StoredInput = {
  file_id: string;
  task_id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
};

export type RunPaths = {
  taskDir: string;
  runDir: string;
  sourcePath: string;
  stdoutPath: string;
  stderrPath: string;
  artifactRoot: string;
  stageDir: string;
  stageInputDir: string;
  stageOutputDir: string;
  resultPath: string;
  metadataPath: string;
};

type IdempotencyRecord = {
  request_hash: string;
  run_id: string;
  created_at: string;
};

function assertSafeRoot(root: string): string {
  const normalized = resolve(root);
  if (!isAbsolute(normalized)) {
    throw new Error('PYTHON_EXECUTOR_STORAGE_ROOT must be absolute.');
  }
  if (
    normalized === '/' ||
    normalized === resolve(homedir()) ||
    normalized === resolve(process.cwd())
  ) {
    throw new Error('Refusing to use a broad directory as executor storage.');
  }
  if (
    normalized.includes(',') ||
    normalized.includes('\r') ||
    normalized.includes('\n') ||
    normalized.includes('\0')
  ) {
    throw new Error('Executor storage path contains unsafe mount characters.');
  }
  return normalized;
}

function ensureInside(root: string, candidate: string): string {
  const normalized = resolve(candidate);
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw new Error('Resolved path escaped the executor storage root.');
  }
  return normalized;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (cause) {
    const code =
      cause && typeof cause === 'object' && 'code' in cause
        ? String(cause.code)
        : '';
    if (code === 'ENOENT') return null;
    throw cause;
  }
}

function idempotencyFileName(keyHash: string): string {
  return keyHash.replace(/^sha256:/, '');
}

export class ExecutorStorage {
  readonly root: string;
  private ownsServiceLock = false;

  constructor(root: string) {
    this.root = assertSafeRoot(root);
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const details = await lstat(this.root);
    if (
      !details.isDirectory() ||
      details.isSymbolicLink() ||
      (details.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && details.uid !== process.getuid())
    ) {
      throw new Error(
        'Executor storage must be a private directory owned by the service user.',
      );
    }
    await mkdir(join(this.root, 'tasks'), { recursive: true, mode: 0o700 });
  }

  async acquireServiceLock(): Promise<void> {
    const lockDir = join(this.root, '.service-lock');
    const acquire = async () => {
      await mkdir(lockDir, { mode: 0o700 });
      await writeJsonAtomic(join(lockDir, 'owner.json'), {
        pid: process.pid,
        started_at: new Date().toISOString(),
      });
      this.ownsServiceLock = true;
    };

    try {
      await acquire();
      return;
    } catch (cause) {
      const code =
        cause && typeof cause === 'object' && 'code' in cause
          ? String(cause.code)
          : '';
      if (code !== 'EEXIST') throw cause;
    }

    const owner = await readJson<{ pid?: unknown }>(
      join(lockDir, 'owner.json'),
    );
    const pid = typeof owner?.pid === 'number' ? owner.pid : null;
    if (!pid || !Number.isInteger(pid) || pid <= 0) {
      throw new Error('Executor service lock exists without a valid owner.');
    }
    try {
      process.kill(pid, 0);
      throw new Error(`Python Executor is already running as PID ${pid}.`);
    } catch (cause) {
      const code =
        cause && typeof cause === 'object' && 'code' in cause
          ? String(cause.code)
          : '';
      if (code !== 'ESRCH') throw cause;
    }

    await rm(lockDir, { recursive: true, force: true });
    await acquire();
  }

  async releaseServiceLock(): Promise<void> {
    if (!this.ownsServiceLock) return;
    const lockDir = join(this.root, '.service-lock');
    const owner = await readJson<{ pid?: unknown }>(
      join(lockDir, 'owner.json'),
    );
    if (owner?.pid === process.pid) {
      await rm(lockDir, { recursive: true, force: true });
    }
    this.ownsServiceLock = false;
  }

  async listTaskIds(): Promise<string[]> {
    const entries = await readdir(join(this.root, 'tasks'));
    return entries.filter(isSafeTaskId);
  }

  taskDir(taskId: string): string {
    if (!isSafeTaskId(taskId)) throw new Error('Unsafe task ID.');
    return ensureInside(this.root, join(this.root, 'tasks', taskId));
  }

  private inputDir(taskId: string, fileId: string): string {
    if (!isSafeFileId(fileId)) throw new Error('Unsafe file ID.');
    return ensureInside(this.root, join(this.taskDir(taskId), 'input', fileId));
  }

  private runDir(taskId: string, runId: string): string {
    if (!/^run_[a-f0-9]{32}$/.test(runId)) throw new Error('Unsafe run ID.');
    return ensureInside(this.root, join(this.taskDir(taskId), 'runs', runId));
  }

  async listInputs(taskId: string): Promise<StoredInput[]> {
    const root = join(this.taskDir(taskId), 'input');
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (cause) {
      const code =
        cause && typeof cause === 'object' && 'code' in cause
          ? String(cause.code)
          : '';
      if (code === 'ENOENT') return [];
      throw cause;
    }
    const records = await Promise.all(
      entries
        .filter(isSafeFileId)
        .map((fileId) =>
          readJson<StoredInput>(
            join(this.inputDir(taskId, fileId), 'metadata.json'),
          ),
        ),
    );
    return records.filter((record): record is StoredInput => record !== null);
  }

  async putInput(options: {
    taskId: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    sha256: string;
  }): Promise<StoredInput> {
    if (!isSafeTaskId(options.taskId) || !isSafeInputName(options.name)) {
      throw new ToolRequestError(
        'INVALID_REQUEST',
        'The task ID or input file name is invalid.',
        { taskId: isSafeTaskId(options.taskId) ? options.taskId : null },
      );
    }
    if (options.bytes.byteLength > EXECUTOR_LIMITS.inputFileBytes) {
      throw new ToolRequestError(
        'INVALID_REQUEST',
        `An input file cannot exceed ${EXECUTOR_LIMITS.inputFileBytes} bytes.`,
        { taskId: options.taskId },
      );
    }

    const existing = await this.listInputs(options.taskId);
    const existingBytes = existing.reduce(
      (total, record) => total + record.size_bytes,
      0,
    );
    if (
      existing.length >= EXECUTOR_LIMITS.inputFiles ||
      existingBytes + options.bytes.byteLength > EXECUTOR_LIMITS.inputTotalBytes
    ) {
      throw new ToolRequestError(
        'INVALID_REQUEST',
        'The task input file quota has been exceeded.',
        { taskId: options.taskId },
      );
    }

    const fileId = `file_${randomUUID().replaceAll('-', '')}`;
    const directory = this.inputDir(options.taskId, fileId);
    await mkdir(join(this.taskDir(options.taskId), 'input'), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(directory, { recursive: false, mode: 0o700 });
    const record: StoredInput = {
      file_id: fileId,
      task_id: options.taskId,
      original_name: options.name,
      mime_type: options.mimeType,
      size_bytes: options.bytes.byteLength,
      sha256: options.sha256,
      created_at: new Date().toISOString(),
    };
    try {
      await writeFile(join(directory, 'content'), options.bytes, {
        mode: 0o400,
      });
      await writeJsonAtomic(join(directory, 'metadata.json'), record);
      return record;
    } catch (cause) {
      await rm(directory, { recursive: true, force: true });
      throw cause;
    }
  }

  async getInput(
    taskId: string,
    fileId: string,
  ): Promise<{
    record: StoredInput;
    contentPath: string;
  }> {
    if (!isSafeTaskId(taskId) || !isSafeFileId(fileId)) {
      throw new ToolRequestError(
        'FILE_UNAVAILABLE',
        'The input file is unavailable.',
        {
          httpStatus: 404,
          taskId: isSafeTaskId(taskId) ? taskId : null,
        },
      );
    }
    const directory = this.inputDir(taskId, fileId);
    const record = await readJson<StoredInput>(
      join(directory, 'metadata.json'),
    );
    if (!record || record.task_id !== taskId || record.file_id !== fileId) {
      throw new ToolRequestError(
        'FILE_UNAVAILABLE',
        'The input file is unavailable.',
        {
          httpStatus: 404,
          taskId,
        },
      );
    }
    const contentPath = join(directory, 'content');
    try {
      const details = await stat(contentPath);
      if (!details.isFile() || details.size !== record.size_bytes)
        throw new Error();
    } catch {
      throw new ToolRequestError(
        'FILE_UNAVAILABLE',
        'The input file is unavailable.',
        {
          httpStatus: 404,
          taskId,
        },
      );
    }
    return { record, contentPath };
  }

  async createRun(
    request: RunPythonRequest,
    runId: string,
    initial: PythonRunResult,
    audit: Record<string, unknown>,
  ): Promise<RunPaths> {
    const runDir = this.runDir(request.task_id, runId);
    const paths: RunPaths = {
      taskDir: this.taskDir(request.task_id),
      runDir,
      sourcePath: join(runDir, 'source', 'main.py'),
      stdoutPath: join(runDir, 'logs', 'stdout.txt'),
      stderrPath: join(runDir, 'logs', 'stderr.txt'),
      artifactRoot: join(runDir, 'artifacts'),
      stageDir: join(runDir, '.stage'),
      stageInputDir: join(runDir, '.stage', 'input'),
      stageOutputDir: join(runDir, '.stage', 'output'),
      resultPath: join(runDir, 'result.json'),
      metadataPath: join(runDir, 'metadata.json'),
    };
    await mkdir(paths.stageInputDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.stageOutputDir, { recursive: true, mode: 0o700 });
    await mkdir(dirname(paths.sourcePath), { recursive: true, mode: 0o700 });
    await mkdir(dirname(paths.stdoutPath), { recursive: true, mode: 0o700 });
    await mkdir(paths.artifactRoot, { recursive: true, mode: 0o700 });
    await writeFile(paths.sourcePath, request.code, {
      encoding: 'utf8',
      mode: 0o444,
    });
    await writeJsonAtomic(join(runDir, 'request.json'), request);
    await writeJsonAtomic(paths.resultPath, initial);
    await writeJsonAtomic(paths.metadataPath, audit);
    return paths;
  }

  async stageInput(
    paths: RunPaths,
    sourcePath: string,
    mountName: string,
  ): Promise<void> {
    if (!isSafeInputName(mountName)) throw new Error('Unsafe mount name.');
    const destination = ensureInside(
      paths.stageInputDir,
      join(paths.stageInputDir, basename(mountName)),
    );
    await copyFile(sourcePath, destination);
    await chmod(destination, 0o444);
  }

  async sealStageInputs(paths: RunPaths): Promise<void> {
    await chmod(paths.stageInputDir, 0o555);
  }

  async writeLogs(
    paths: RunPaths,
    stdout: string,
    stderr: string,
  ): Promise<void> {
    await Promise.all([
      writeFile(paths.stdoutPath, stdout, { encoding: 'utf8', mode: 0o600 }),
      writeFile(paths.stderrPath, stderr, { encoding: 'utf8', mode: 0o600 }),
    ]);
  }

  async writeResult(result: PythonRunResult): Promise<void> {
    const path = join(
      this.runDir(result.task_id, result.run_id),
      'result.json',
    );
    await writeJsonAtomic(path, result);
  }

  async writeAudit(
    paths: RunPaths,
    audit: Record<string, unknown>,
  ): Promise<void> {
    await writeJsonAtomic(paths.metadataPath, audit);
  }

  async readResult(
    taskId: string,
    runId: string,
  ): Promise<PythonRunResult | null> {
    if (!isSafeTaskId(taskId) || !/^run_[a-f0-9]{32}$/.test(runId)) {
      return null;
    }
    return readJson<PythonRunResult>(
      join(this.runDir(taskId, runId), 'result.json'),
    );
  }

  async listRunIds(taskId: string): Promise<string[]> {
    const directory = join(this.taskDir(taskId), 'runs');
    try {
      return (await readdir(directory)).filter((entry) =>
        /^run_[a-f0-9]{32}$/.test(entry),
      );
    } catch (cause) {
      const code =
        cause && typeof cause === 'object' && 'code' in cause
          ? String(cause.code)
          : '';
      if (code === 'ENOENT') return [];
      throw cause;
    }
  }

  async listRunResults(taskId: string): Promise<PythonRunResult[]> {
    const runIds = await this.listRunIds(taskId);
    const results = await Promise.all(
      runIds.map((runId) => this.readResult(taskId, runId)),
    );
    return results
      .filter((result): result is PythonRunResult => result !== null)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  private idempotencyPath(taskId: string, keyHash: string): string {
    return ensureInside(
      this.root,
      join(
        this.taskDir(taskId),
        'idempotency',
        `${idempotencyFileName(keyHash)}.json`,
      ),
    );
  }

  async readIdempotency(
    taskId: string,
    keyHash: string,
  ): Promise<IdempotencyRecord | null> {
    return readJson<IdempotencyRecord>(this.idempotencyPath(taskId, keyHash));
  }

  async reserveIdempotency(
    taskId: string,
    keyHash: string,
    record: IdempotencyRecord,
  ): Promise<void> {
    const path = this.idempotencyPath(taskId, keyHash);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
  }

  async removeStage(paths: RunPaths): Promise<void> {
    const safeStage = ensureInside(paths.runDir, paths.stageDir);
    try {
      await chmod(paths.stageInputDir, 0o700);
    } catch {
      // The directory may not exist when staging failed before it was created.
    }
    await rm(safeStage, { recursive: true, force: true });
  }

  async getArtifact(options: {
    taskId: string;
    runId: string;
    artifactId: string;
  }): Promise<{
    path: string;
    name: string;
    mimeType: string;
    size: number;
  } | null> {
    if (!/^artifact_[a-f0-9]{32}$/.test(options.artifactId)) return null;
    const result = await this.readResult(options.taskId, options.runId);
    if (!result || result.status !== 'succeeded') return null;
    const artifact = result.artifacts.find(
      (candidate) => candidate.artifact_id === options.artifactId,
    );
    if (!artifact || basename(artifact.name) !== artifact.name) return null;
    const path = ensureInside(
      this.runDir(options.taskId, options.runId),
      join(
        this.runDir(options.taskId, options.runId),
        'artifacts',
        artifact.artifact_id,
        artifact.name,
      ),
    );
    try {
      const details = await stat(path);
      if (!details.isFile() || details.size !== artifact.size_bytes)
        return null;
    } catch {
      return null;
    }
    return {
      path,
      name: artifact.name,
      mimeType: artifact.mime_type,
      size: artifact.size_bytes,
    };
  }

  async recoverInterruptedRun(result: PythonRunResult): Promise<void> {
    const runDir = this.runDir(result.task_id, result.run_id);
    const stageInput = join(runDir, '.stage', 'input');
    try {
      await chmod(stageInput, 0o700);
    } catch {
      // It may not have reached input staging before the worker stopped.
    }
    await rm(join(runDir, '.stage'), { recursive: true, force: true });
    await rm(join(runDir, 'artifacts'), { recursive: true, force: true });
    await mkdir(join(runDir, 'artifacts'), { recursive: true, mode: 0o700 });
    await mkdir(join(runDir, 'logs'), { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(join(runDir, 'logs', 'stdout.txt'), result.stdout ?? '', {
        encoding: 'utf8',
        mode: 0o600,
      }),
      writeFile(join(runDir, 'logs', 'stderr.txt'), result.stderr ?? '', {
        encoding: 'utf8',
        mode: 0o600,
      }),
      this.writeResult(result),
    ]);

    const metadataPath = join(runDir, 'metadata.json');
    const audit = (await readJson<Record<string, unknown>>(metadataPath)) ?? {};
    const history = Array.isArray(audit.state_history)
      ? audit.state_history
      : [];
    history.push({ status: result.status, at: result.finished_at });
    await writeJsonAtomic(metadataPath, {
      ...audit,
      artifacts: [],
      state_history: history,
      internal_error:
        'Executor restarted before the run reached a terminal state.',
      cleanup_status: result.cleanup_status,
    });
  }
}
