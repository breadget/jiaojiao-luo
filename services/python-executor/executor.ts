import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import {
  ArtifactRejectedError,
  validateAndPublishArtifacts,
} from './artifacts';
import {
  SandboxInfrastructureError,
  type SandboxBackend,
  type SandboxRunOutcome,
} from './docker-runner';
import {
  EXECUTOR_LIMITS,
  EXECUTOR_PROFILES,
  PYTHON_EXECUTOR_PROTOCOL,
  ToolRequestError,
  errorFingerprint,
  normalizedRequestHash,
  type PythonRunError,
  type PythonRunErrorCode,
  type PythonRunResult,
  type RunPythonRequest,
  inputMimeType,
  validateRunPythonRequest,
  validateInputBytes,
  isSafeInputName,
  isSafeTaskId,
} from './protocol';
import { ExecutorStorage, type RunPaths, type StoredInput } from './storage';

type ResolvedInput = {
  record: StoredInput;
  contentPath: string;
  mountName: string;
};

type ExecutorOptions = {
  storage: ExecutorStorage;
  sandbox: SandboxBackend;
  sandboxImage: string;
  maximumQueuedRuns?: number;
  now?: () => Date;
};

type AuditRecord = {
  protocol: typeof PYTHON_EXECUTOR_PROTOCOL;
  policy_version: 'python-sandbox.v1';
  task_id: string;
  run_id: string;
  attempt: number;
  parent_run_id: string | null;
  idempotency_key_hash: string;
  request_hash: string;
  code_sha256: string;
  inputs: Array<{
    file_id: string;
    mount_name: string;
    size_bytes: number;
    sha256: string;
  }>;
  artifacts: PythonRunResult['artifacts'];
  sandbox_image: string;
  effective_limits: PythonRunResult['limits'];
  state_history: Array<{ status: PythonRunResult['status']; at: string }>;
  stdout_seen_bytes: number | null;
  stderr_seen_bytes: number | null;
  internal_error: string | null;
  cleanup_status: PythonRunResult['cleanup_status'];
};

type ActiveRun = {
  taskId: string;
  controller: AbortController;
  promise: Promise<PythonRunResult>;
  paths: RunPaths;
  audit: AuditRecord;
};

class SerialQueue {
  private tail = Promise.resolve();
  private pending = 0;

  get size(): number {
    return this.pending;
  }

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    return previous.then(operation).finally(() => {
      this.pending -= 1;
      release();
    });
  }
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function iso(date: Date): string {
  return date.toISOString();
}

function limitsFor(request: RunPythonRequest): PythonRunResult['limits'] {
  const profile = EXECUTOR_PROFILES[request.profile];
  return {
    timeout_seconds: request.timeout_seconds,
    cpu_count: profile.cpuCount,
    memory_bytes: profile.memoryBytes,
    processes: EXECUTOR_LIMITS.processes,
    stdout_bytes: EXECUTOR_LIMITS.streamBytes,
    stderr_bytes: EXECUTOR_LIMITS.streamBytes,
  };
}

function runError(
  code: PythonRunErrorCode,
  message: string,
  retryable: boolean,
  stderr: string,
): PythonRunError {
  return {
    code,
    message,
    retryable,
    error_fingerprint: errorFingerprint(code, `${message}\n${stderr}`),
  };
}

function outcomeResult(options: {
  current: PythonRunResult;
  outcome: SandboxRunOutcome;
  now: Date;
}): PythonRunResult {
  const { current, outcome } = options;
  const base: PythonRunResult = {
    ...current,
    exit_code: outcome.exitCode,
    stdout: outcome.stdout.text,
    stderr: outcome.stderr.text,
    stdout_truncated: outcome.stdout.truncated,
    stderr_truncated: outcome.stderr.truncated,
    metrics: {
      ...current.metrics,
      duration_ms: outcome.durationMs,
      cpu_time_ms: outcome.cpuTimeMs,
      peak_memory_bytes: outcome.peakMemoryBytes,
    },
    finished_at: iso(options.now),
    cleanup_status: outcome.cleanupConfirmed ? 'succeeded' : 'failed',
  };

  if (outcome.kind === 'worker_error' || !outcome.cleanupConfirmed) {
    return {
      ...base,
      status: 'failed',
      artifacts: [],
      error: runError(
        'WORKER_ERROR',
        'The sandbox worker failed safely.',
        false,
        outcome.stderr.text,
      ),
    };
  }
  if (outcome.kind === 'timed_out') {
    return {
      ...base,
      status: 'timed_out',
      artifacts: [],
      error: runError(
        'TIMEOUT',
        'Python execution reached its wall-clock limit.',
        false,
        outcome.stderr.text,
      ),
    };
  }
  if (outcome.kind === 'cancelled') {
    return {
      ...base,
      status: 'killed',
      artifacts: [],
      error: runError(
        'CANCELLED',
        'Python execution was cancelled.',
        false,
        outcome.stderr.text,
      ),
    };
  }
  if (outcome.kind === 'memory_limit') {
    return {
      ...base,
      status: 'killed',
      artifacts: [],
      error: runError(
        'MEMORY_LIMIT',
        'Python execution exceeded its memory limit.',
        false,
        outcome.stderr.text,
      ),
    };
  }
  if (outcome.kind === 'output_limit') {
    return {
      ...base,
      status: 'killed',
      artifacts: [],
      error: runError(
        'POLICY_VIOLATION',
        'Python execution exceeded its output volume limit.',
        false,
        outcome.stderr.text,
      ),
    };
  }
  if (outcome.exitCode !== 0) {
    return {
      ...base,
      status: 'failed',
      artifacts: [],
      error: runError(
        'PROCESS_EXIT_NONZERO',
        'Python exited with a non-zero status.',
        true,
        outcome.stderr.text,
      ),
    };
  }
  return { ...base, status: 'succeeded', error: null };
}

export class PythonExecutor {
  private readonly storage: ExecutorStorage;
  private readonly sandbox: SandboxBackend;
  private readonly sandboxImage: string;
  private readonly maximumQueuedRuns: number;
  private readonly now: () => Date;
  private readonly queue = new SerialQueue();
  private readonly taskLocks = new Map<string, Promise<void>>();
  private readonly activeTasks = new Set<string>();
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(options: ExecutorOptions) {
    this.storage = options.storage;
    this.sandbox = options.sandbox;
    this.sandboxImage = options.sandboxImage;
    this.maximumQueuedRuns = options.maximumQueuedRuns ?? 20;
    this.now = options.now ?? (() => new Date());
  }

  async init(): Promise<void> {
    await this.storage.init();
    await this.storage.acquireServiceLock();
    try {
      await this.sandbox.preflight();
      const recoveredAt = this.now();
      for (const taskId of await this.storage.listTaskIds()) {
        for (const runId of await this.storage.listRunIds(taskId)) {
          const result = await this.storage.readResult(taskId, runId);
          if (!result || !['queued', 'running'].includes(result.status)) {
            continue;
          }
          const recovered: PythonRunResult = {
            ...result,
            status: 'failed',
            exit_code: null,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            artifacts: [],
            error: runError(
              'WORKER_ERROR',
              'The sandbox worker restarted before execution completed.',
              false,
              result.stderr ?? '',
            ),
            finished_at: iso(recoveredAt),
            cleanup_status: 'succeeded',
          };
          await this.storage.recoverInterruptedRun(recovered);
        }
      }
    } catch (cause) {
      await this.storage.releaseServiceLock();
      throw cause;
    }
  }

  async shutdown(): Promise<void> {
    await this.storage.releaseServiceLock();
  }

  async storeInput(options: {
    taskId: string;
    name: string;
    bytes: Uint8Array;
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
    const rejection = validateInputBytes(options.name, options.bytes);
    if (rejection) {
      throw new ToolRequestError('INVALID_REQUEST', rejection, {
        taskId: options.taskId,
      });
    }
    const mimeType = inputMimeType(options.name);
    if (!mimeType) {
      throw new ToolRequestError(
        'INVALID_REQUEST',
        'The input file type is not allowed.',
        { taskId: options.taskId },
      );
    }
    return this.withTaskLock(options.taskId, () =>
      this.storage.putInput({
        taskId: options.taskId,
        name: options.name,
        mimeType,
        bytes: options.bytes,
        sha256: `sha256:${createHash('sha256').update(options.bytes).digest('hex')}`,
      }),
    );
  }

  private async withTaskLock<T>(
    taskId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.taskLocks.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.taskLocks.set(taskId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.taskLocks.get(taskId) === current) this.taskLocks.delete(taskId);
    }
  }

  private async resolveInputs(
    request: RunPythonRequest,
  ): Promise<ResolvedInput[]> {
    const resolved: ResolvedInput[] = [];
    let totalBytes = 0;
    for (const input of request.input_files) {
      const stored = await this.storage.getInput(
        request.task_id,
        input.file_id,
      );
      totalBytes += stored.record.size_bytes;
      if (totalBytes > EXECUTOR_LIMITS.inputTotalBytes) {
        throw new ToolRequestError(
          'INVALID_REQUEST',
          'The selected input files exceed the per-run total size limit.',
          { taskId: request.task_id },
        );
      }
      resolved.push({
        ...stored,
        mountName: input.mount_name,
      });
    }
    return resolved;
  }

  private initialResult(
    request: RunPythonRequest,
    runId: string,
    parentRunId: string | null,
    createdAt: Date,
  ): PythonRunResult {
    return {
      protocol: PYTHON_EXECUTOR_PROTOCOL,
      task_id: request.task_id,
      run_id: runId,
      attempt: request.attempt,
      parent_run_id: parentRunId,
      profile: request.profile,
      status: 'queued',
      exit_code: null,
      stdout: null,
      stderr: null,
      stdout_truncated: false,
      stderr_truncated: false,
      artifacts: [],
      error: null,
      metrics: {
        queued_ms: null,
        duration_ms: null,
        cpu_time_ms: null,
        peak_memory_bytes: null,
      },
      limits: limitsFor(request),
      created_at: iso(createdAt),
      started_at: null,
      finished_at: null,
      cleanup_status: 'pending',
    };
  }

  private auditRecord(options: {
    request: RunPythonRequest;
    requestHash: string;
    idempotencyKeyHash: string;
    result: PythonRunResult;
    inputs: ResolvedInput[];
  }): AuditRecord {
    return {
      protocol: PYTHON_EXECUTOR_PROTOCOL,
      policy_version: 'python-sandbox.v1',
      task_id: options.request.task_id,
      run_id: options.result.run_id,
      attempt: options.request.attempt,
      parent_run_id: options.result.parent_run_id,
      idempotency_key_hash: options.idempotencyKeyHash,
      request_hash: options.requestHash,
      code_sha256: sha256(options.request.code),
      inputs: options.inputs.map((input) => ({
        file_id: input.record.file_id,
        mount_name: input.mountName,
        size_bytes: input.record.size_bytes,
        sha256: input.record.sha256,
      })),
      artifacts: [],
      sandbox_image: this.sandboxImage,
      effective_limits: options.result.limits,
      state_history: [{ status: 'queued', at: options.result.created_at }],
      stdout_seen_bytes: null,
      stderr_seen_bytes: null,
      internal_error: null,
      cleanup_status: 'pending',
    };
  }

  async submit(value: unknown): Promise<PythonRunResult> {
    const request = validateRunPythonRequest(value);
    const requestHash = normalizedRequestHash(request);
    const idempotencyKeyHash = sha256(request.idempotency_key);

    const prepared = await this.withTaskLock(request.task_id, async () => {
      const idempotency = await this.storage.readIdempotency(
        request.task_id,
        idempotencyKeyHash,
      );
      if (idempotency) {
        if (idempotency.request_hash !== requestHash) {
          throw new ToolRequestError(
            'IDEMPOTENCY_CONFLICT',
            'The idempotency key was already used with a different request.',
            { httpStatus: 409, taskId: request.task_id },
          );
        }
        const active = this.activeRuns.get(idempotency.run_id);
        if (active) {
          const result = await this.storage.readResult(
            request.task_id,
            idempotency.run_id,
          );
          if (result) return { kind: 'result' as const, result };
        }
        const result = await this.storage.readResult(
          request.task_id,
          idempotency.run_id,
        );
        if (!result) {
          throw new ToolRequestError(
            'CAPACITY_EXCEEDED',
            'The previous run record is being recovered.',
            {
              httpStatus: 503,
              retryable: true,
              taskId: request.task_id,
            },
          );
        }
        return { kind: 'result' as const, result };
      }

      const runIds = await this.storage.listRunIds(request.task_id);
      const previousResults = await Promise.all(
        runIds.map((runId) => this.storage.readResult(request.task_id, runId)),
      );
      if (previousResults.some((result) => result === null)) {
        throw new ToolRequestError(
          'CAPACITY_EXCEEDED',
          'A previous run record is incomplete and requires recovery.',
          { httpStatus: 503, retryable: true, taskId: request.task_id },
        );
      }
      const settledResults = previousResults
        .filter((result): result is PythonRunResult => result !== null)
        .sort((left, right) => left.attempt - right.attempt);
      if (runIds.length >= 3) {
        throw new ToolRequestError(
          'ATTEMPT_LIMIT',
          'The task has already used all three Python attempts.',
          { httpStatus: 409, taskId: request.task_id },
        );
      }
      if (request.attempt !== runIds.length + 1) {
        throw new ToolRequestError(
          'INVALID_REQUEST',
          `attempt must be ${runIds.length + 1} for this task.`,
          { httpStatus: 409, taskId: request.task_id },
        );
      }
      const previous = settledResults.at(-1);
      if (
        previous &&
        (previous.status === 'queued' || previous.status === 'running')
      ) {
        throw new ToolRequestError(
          'CAPACITY_EXCEEDED',
          'This task already has a queued or running Python attempt.',
          { httpStatus: 429, retryable: true, taskId: request.task_id },
        );
      }
      if (
        previous &&
        (previous.status === 'succeeded' || previous.error?.retryable !== true)
      ) {
        throw new ToolRequestError(
          'ATTEMPT_LIMIT',
          'The previous terminal state does not allow an automatic retry.',
          { httpStatus: 409, taskId: request.task_id },
        );
      }
      const beforePrevious = settledResults.at(-2);
      if (
        previous?.error?.error_fingerprint &&
        previous.error.error_fingerprint ===
          beforePrevious?.error?.error_fingerprint
      ) {
        throw new ToolRequestError(
          'ATTEMPT_LIMIT',
          'The same normalized error occurred twice in a row.',
          { httpStatus: 409, taskId: request.task_id },
        );
      }
      if (this.activeTasks.has(request.task_id)) {
        throw new ToolRequestError(
          'CAPACITY_EXCEEDED',
          'This task already has a queued or running Python attempt.',
          { httpStatus: 429, retryable: true, taskId: request.task_id },
        );
      }
      if (this.queue.size >= this.maximumQueuedRuns) {
        throw new ToolRequestError(
          'CAPACITY_EXCEEDED',
          'The executor queue is full.',
          { httpStatus: 429, retryable: true, taskId: request.task_id },
        );
      }

      const inputs = await this.resolveInputs(request);
      const runId = `run_${randomUUID().replaceAll('-', '')}`;
      const parentRunId = settledResults.at(-1)?.run_id ?? null;
      const createdAt = this.now();
      const initial = this.initialResult(
        request,
        runId,
        parentRunId,
        createdAt,
      );
      const audit = this.auditRecord({
        request,
        requestHash,
        idempotencyKeyHash,
        result: initial,
        inputs,
      });
      const paths = await this.storage.createRun(
        request,
        runId,
        initial,
        audit,
      );
      await this.storage.reserveIdempotency(
        request.task_id,
        idempotencyKeyHash,
        {
          request_hash: requestHash,
          run_id: runId,
          created_at: initial.created_at,
        },
      );

      this.activeTasks.add(request.task_id);
      const controller = new AbortController();
      const promise = this.queue
        .enqueue(() =>
          this.execute(
            request,
            inputs,
            paths,
            initial,
            audit,
            controller.signal,
          ),
        )
        .finally(() => {
          this.activeTasks.delete(request.task_id);
          this.activeRuns.delete(runId);
        });
      this.activeRuns.set(runId, {
        taskId: request.task_id,
        controller,
        promise,
        paths,
        audit,
      });
      // execute() 会把基础设施故障收敛为终态；这一层只防止未预期的
      // 存储异常变成 unhandled rejection。已接受的 HTTP 响应不因后台结束而延迟。
      void promise.catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        process.stderr.write(
          `[python-executor] background run failed: ${message}\n`,
        );
      });
      return { kind: 'result' as const, result: initial };
    });

    return prepared.result;
  }

  private async execute(
    request: RunPythonRequest,
    inputs: ResolvedInput[],
    paths: RunPaths,
    initial: PythonRunResult,
    audit: AuditRecord,
    signal: AbortSignal,
  ): Promise<PythonRunResult> {
    const startedAt = this.now();
    const started = await this.withTaskLock(request.task_id, async () => {
      const persisted = await this.storage.readResult(
        request.task_id,
        initial.run_id,
      );
      if (persisted && persisted.status !== 'queued') return persisted;
      if (signal.aborted) {
        return this.finishQueuedCancellation(initial, paths, audit);
      }
      const running: PythonRunResult = {
        ...initial,
        status: 'running',
        started_at: iso(startedAt),
        metrics: {
          ...initial.metrics,
          queued_ms: Math.max(
            0,
            startedAt.getTime() - new Date(initial.created_at).getTime(),
          ),
        },
      };
      audit.state_history.push({
        status: 'running',
        at: running.started_at ?? iso(startedAt),
      });
      await Promise.all([
        this.storage.writeResult(running),
        this.storage.writeAudit(paths, audit),
      ]);
      return running;
    });
    if (started.status !== 'running') return started;
    let current = started;

    let outcome: SandboxRunOutcome;
    try {
      for (const input of inputs) {
        await this.storage.stageInput(
          paths,
          input.contentPath,
          input.mountName,
        );
      }
      await this.storage.sealStageInputs(paths);
      outcome = await this.sandbox.run({
        runId: current.run_id,
        sourcePath: paths.sourcePath,
        inputDir: paths.stageInputDir,
        outputDir: paths.stageOutputDir,
        timeoutSeconds: request.timeout_seconds,
        memoryBytes: current.limits.memory_bytes,
        cpuCount: current.limits.cpu_count,
        processes: current.limits.processes,
        signal,
      });
    } catch (cause) {
      outcome = {
        kind: 'worker_error',
        exitCode: null,
        stdout: { text: '', truncated: false, seenBytes: 0 },
        stderr: { text: '', truncated: false, seenBytes: 0 },
        durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        cpuTimeMs: null,
        peakMemoryBytes: null,
        cleanupConfirmed: false,
        errorMessage: cause instanceof Error ? cause.message : String(cause),
      };
    }

    await this.storage.writeLogs(
      paths,
      outcome.stdout.text,
      outcome.stderr.text,
    );
    current = outcomeResult({ current, outcome, now: this.now() });

    if (current.status === 'succeeded') {
      try {
        current.artifacts = await validateAndPublishArtifacts({
          outputDir: paths.stageOutputDir,
          artifactRoot: paths.artifactRoot,
          validatePng: (path, maximumPixels) =>
            this.sandbox.validatePng(path, maximumPixels),
          validateXlsx: (path) => this.sandbox.validateXlsx(path),
          validatePdf: (path) => this.sandbox.validatePdf(path),
          validateDocx: (path) => this.sandbox.validateDocx(path),
          validatePptx: (path) => this.sandbox.validatePptx(path),
        });
      } catch (cause) {
        const infrastructureFailure =
          cause instanceof SandboxInfrastructureError;
        const code = infrastructureFailure
          ? 'WORKER_ERROR'
          : 'ARTIFACT_REJECTED';
        const message = infrastructureFailure
          ? 'The sandbox worker failed safely.'
          : cause instanceof ArtifactRejectedError
            ? cause.message
            : 'Artifact validation failed.';
        current = {
          ...current,
          status: 'failed',
          artifacts: [],
          error: runError(
            code,
            message,
            !infrastructureFailure,
            outcome.stderr.text,
          ),
        };
        audit.internal_error =
          cause instanceof Error ? cause.message : String(cause);
        await rm(paths.artifactRoot, { recursive: true, force: true });
      }
    }

    try {
      await this.storage.removeStage(paths);
    } catch (cause) {
      current = {
        ...current,
        status: 'failed',
        artifacts: [],
        cleanup_status: 'failed',
        error: runError(
          'WORKER_ERROR',
          'The sandbox worker failed safely.',
          false,
          outcome.stderr.text,
        ),
      };
      audit.internal_error =
        cause instanceof Error ? cause.message : String(cause);
      await rm(paths.artifactRoot, { recursive: true, force: true });
    }

    audit.artifacts = current.artifacts;
    audit.stdout_seen_bytes = outcome.stdout.seenBytes;
    audit.stderr_seen_bytes = outcome.stderr.seenBytes;
    audit.cleanup_status = current.cleanup_status;
    audit.internal_error ??= outcome.errorMessage;
    audit.state_history.push({
      status: current.status,
      at: current.finished_at ?? iso(this.now()),
    });
    await Promise.all([
      this.storage.writeResult(current),
      this.storage.writeAudit(paths, audit),
    ]);
    return current;
  }

  private async finishQueuedCancellation(
    initial: PythonRunResult,
    paths: RunPaths,
    audit: AuditRecord,
  ): Promise<PythonRunResult> {
    const finishedAt = this.now();
    let cleanupStatus: PythonRunResult['cleanup_status'] = 'succeeded';
    let internalError: string | null = null;
    try {
      await this.storage.removeStage(paths);
    } catch (cause) {
      cleanupStatus = 'failed';
      internalError = cause instanceof Error ? cause.message : String(cause);
    }
    const result: PythonRunResult = {
      ...initial,
      status: 'killed',
      error: runError(
        cleanupStatus === 'succeeded' ? 'CANCELLED' : 'WORKER_ERROR',
        cleanupStatus === 'succeeded'
          ? 'Python execution was cancelled before it started.'
          : 'The sandbox worker failed safely.',
        false,
        '',
      ),
      finished_at: iso(finishedAt),
      cleanup_status: cleanupStatus,
    };
    audit.cleanup_status = cleanupStatus;
    audit.internal_error = internalError;
    audit.state_history.push({
      status: result.status,
      at: result.finished_at ?? iso(finishedAt),
    });
    await Promise.all([
      this.storage.writeResult(result),
      this.storage.writeAudit(paths, audit),
    ]);
    return result;
  }

  async cancelRun(
    taskId: string,
    runId: string,
  ): Promise<PythonRunResult | null> {
    return this.withTaskLock(taskId, async () => {
      const current = await this.storage.readResult(taskId, runId);
      if (!current) return null;
      if (current.status !== 'queued' && current.status !== 'running') {
        return current;
      }
      const active = this.activeRuns.get(runId);
      if (!active || active.taskId !== taskId) return current;
      active.controller.abort();
      if (current.status === 'queued') {
        return this.finishQueuedCancellation(
          current,
          active.paths,
          active.audit,
        );
      }
      // 运行中的容器由 AbortSignal 触发 docker kill；这里立即回传当前
      // 状态，调用方继续轮询，直到 killed/CANCELLED 与清理结果落盘。
      return current;
    });
  }

  async getRun(taskId: string, runId: string): Promise<PythonRunResult | null> {
    return this.storage.readResult(taskId, runId);
  }

  /** 进程内的优雅停机与核心测试使用；HTTP 调用方仍必须通过 GET 轮询。 */
  async waitForRun(
    taskId: string,
    runId: string,
  ): Promise<PythonRunResult | null> {
    const active = this.activeRuns.get(runId);
    if (active?.taskId === taskId) return active.promise;
    return this.storage.readResult(taskId, runId);
  }

  async listRuns(taskId: string): Promise<PythonRunResult[]> {
    return this.storage.listRunResults(taskId);
  }

  async getArtifact(options: {
    taskId: string;
    runId: string;
    artifactId: string;
  }) {
    return this.storage.getArtifact(options);
  }
}
