import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import {
  LOCAL_CONTROL_LIMITS,
  LOCAL_CONTROL_PROTOCOL,
  type LocalControlErrorCode,
  type LocalControlRunObservation,
} from '../../lib/local-control-protocol';
import {
  LocalControlRequestError,
  type ParsedLocalControlSubmission,
} from './protocol';
import { LocalControlStorage } from './storage';

type RequestedTerminalStatus = 'cancelled' | 'timed_out' | null;

type LiveRun = {
  observation: LocalControlRunObservation;
  requestFingerprint: string;
  timeoutSeconds: number;
  child: ReturnType<typeof spawn> | null;
  requestedTerminalStatus: RequestedTerminalStatus;
  timeout: NodeJS.Timeout | null;
  forceKillTimeout: NodeJS.Timeout | null;
  stdioGrace: NodeJS.Timeout | null;
  writes: Promise<void>;
};

type LocalControlExecutorOptions = {
  storage: LocalControlStorage;
  shell: string;
  defaultCwd: string;
  maximumQueuedRuns?: number;
};

type FinishResult = {
  status: Extract<
    LocalControlRunObservation['status'],
    'succeeded' | 'failed' | 'timed_out' | 'cancelled'
  >;
  error: LocalControlRunObservation['error'];
};

function terminal(status: LocalControlRunObservation['status']): boolean {
  return !['queued', 'running'].includes(status);
}

function requestFingerprint(request: ParsedLocalControlSubmission): string {
  return JSON.stringify({
    protocol: request.protocol,
    task_id: request.task_id,
    idempotency_key: request.idempotency_key,
    command: request.command,
    cwd: request.cwd,
    timeout_seconds: request.timeout_seconds,
    reason: request.reason,
  });
}

function errorFor(
  code: LocalControlErrorCode,
  message: string,
): LocalControlRunObservation['error'] {
  return { code, message };
}

function appendBounded(
  current: string,
  chunk: Buffer,
  limit: number,
): { value: string; truncated: boolean } {
  const currentBytes = Buffer.byteLength(current, 'utf8');
  if (currentBytes >= limit) return { value: current, truncated: true };
  const available = limit - currentBytes;
  if (chunk.byteLength <= available) {
    return { value: current + chunk.toString('utf8'), truncated: false };
  }
  return {
    value: current + chunk.subarray(0, available).toString('utf8'),
    truncated: true,
  };
}

/**
 * A deliberately unrestricted, current-user shell runner.
 *
 * The security boundary is process placement, not a command allow-list: this
 * class must only be reachable through the loopback-only authenticated server.
 */
export class LocalControlExecutor {
  private readonly storage: LocalControlStorage;
  private readonly shell: string;
  private readonly defaultCwd: string;
  private readonly maximumQueuedRuns: number;
  private readonly runs = new Map<string, LiveRun>();
  private readonly idempotency = new Map<string, string>();
  private readonly queue: string[] = [];
  private draining = false;
  private shuttingDown = false;

  constructor(options: LocalControlExecutorOptions) {
    this.storage = options.storage;
    this.shell = options.shell;
    this.defaultCwd = options.defaultCwd;
    this.maximumQueuedRuns = options.maximumQueuedRuns ?? 20;
    if (!Number.isInteger(this.maximumQueuedRuns) || this.maximumQueuedRuns < 1) {
      throw new Error('maximumQueuedRuns must be a positive integer.');
    }
  }

  async init(): Promise<void> {
    await this.storage.init();
    const restored = await this.storage.loadRuns();
    for (const observation of restored) {
      const recovered = { ...observation };
      if (!terminal(recovered.status)) {
        recovered.status = 'failed';
        recovered.pid = null;
        recovered.finished_at = new Date().toISOString();
        recovered.error = errorFor(
          'NODE_RESTARTED',
          'The local control process restarted before this command reached a terminal state.',
        );
        await this.storage.saveRun(recovered);
        await this.storage.appendAudit('finished', recovered);
      }
      const key = `${recovered.task_id}:${recovered.idempotency_key}`;
      this.runs.set(recovered.run_id, {
        observation: recovered,
        requestFingerprint: JSON.stringify({
          protocol: recovered.protocol,
          task_id: recovered.task_id,
          idempotency_key: recovered.idempotency_key,
          command: recovered.command,
          cwd: recovered.cwd,
          timeout_seconds: recovered.timeout_seconds,
          reason: recovered.reason,
        }),
        timeoutSeconds: recovered.timeout_seconds,
        child: null,
        requestedTerminalStatus: null,
        timeout: null,
        forceKillTimeout: null,
        stdioGrace: null,
        writes: Promise.resolve(),
      });
      this.idempotency.set(key, recovered.run_id);
    }
  }

  async submit(
    request: ParsedLocalControlSubmission,
  ): Promise<LocalControlRunObservation> {
    if (this.shuttingDown) {
      throw new LocalControlRequestError(
        'CAPACITY_EXCEEDED',
        'The local control service is shutting down.',
        503,
      );
    }
    const cwdInfo = await stat(request.cwd).catch(() => null);
    if (!cwdInfo?.isDirectory()) {
      throw new LocalControlRequestError(
        'INVALID_REQUEST',
        'cwd does not exist or is not a directory.',
      );
    }

    const key = `${request.task_id}:${request.idempotency_key}`;
    const fingerprint = requestFingerprint(request);
    const existingRunId = this.idempotency.get(key);
    if (existingRunId) {
      const existing = this.runs.get(existingRunId);
      if (existing?.requestFingerprint === fingerprint) {
        return structuredClone(existing.observation);
      }
      throw new LocalControlRequestError(
        'IDEMPOTENCY_CONFLICT',
        'The idempotency key was already used for a different command.',
        409,
      );
    }

    if (this.queue.length >= this.maximumQueuedRuns) {
      throw new LocalControlRequestError(
        'CAPACITY_EXCEEDED',
        'The local control queue is full.',
        429,
      );
    }

    const observation: LocalControlRunObservation = {
      protocol: LOCAL_CONTROL_PROTOCOL,
      task_id: request.task_id,
      run_id: `shell_${randomBytes(16).toString('hex')}`,
      idempotency_key: request.idempotency_key,
      status: 'queued',
      command: request.command,
      cwd: request.cwd || this.defaultCwd,
      shell: this.shell,
      timeout_seconds: request.timeout_seconds,
      reason: request.reason,
      pid: null,
      exit_code: null,
      signal: null,
      stdout: '',
      stderr: '',
      stdout_truncated: false,
      stderr_truncated: false,
      cancellation_requested: false,
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      error: null,
    };
    const live: LiveRun = {
      observation,
      requestFingerprint: fingerprint,
      timeoutSeconds: request.timeout_seconds,
      child: null,
      requestedTerminalStatus: null,
      timeout: null,
      forceKillTimeout: null,
      stdioGrace: null,
      writes: Promise.resolve(),
    };
    this.runs.set(observation.run_id, live);
    this.idempotency.set(key, observation.run_id);
    this.queue.push(observation.run_id);
    await this.enqueueWrite(live, async () => {
      await this.storage.saveRun(observation);
      await this.storage.appendAudit('submitted', observation);
    });
    queueMicrotask(() => void this.drain());
    return structuredClone(observation);
  }

  getRun(taskId: string, runId: string): LocalControlRunObservation | null {
    const run = this.runs.get(runId);
    if (!run || run.observation.task_id !== taskId) return null;
    return structuredClone(run.observation);
  }

  listRuns(taskId: string): LocalControlRunObservation[] {
    return [...this.runs.values()]
      .map((run) => run.observation)
      .filter((run) => run.task_id === taskId)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .map((run) => structuredClone(run));
  }

  async cancelRun(
    taskId: string,
    runId: string,
  ): Promise<LocalControlRunObservation | null> {
    const run = this.runs.get(runId);
    if (!run || run.observation.task_id !== taskId) return null;
    if (terminal(run.observation.status)) {
      return structuredClone(run.observation);
    }
    run.observation.cancellation_requested = true;
    if (run.observation.status === 'queued') {
      const index = this.queue.indexOf(runId);
      if (index >= 0) this.queue.splice(index, 1);
      run.observation.status = 'cancelled';
      run.observation.finished_at = new Date().toISOString();
      run.observation.error = errorFor(
        'CANCELLED',
        'The command was cancelled before it started.',
      );
      const cancelled = structuredClone(run.observation);
      await this.enqueueWrite(run, async () => {
        await this.storage.saveRun(cancelled);
        await this.storage.appendAudit('finished', cancelled);
      });
      return structuredClone(run.observation);
    }

    run.requestedTerminalStatus = 'cancelled';
    run.observation.error = errorFor(
      'CANCELLED',
      'Cancellation was requested by the local user.',
    );
    const requested = structuredClone(run.observation);
    await this.enqueueWrite(run, async () => {
      await this.storage.saveRun(requested);
      await this.storage.appendAudit('cancel-requested', requested);
    });
    this.signalRun(run, 'SIGTERM');
    this.scheduleForceKill(run);
    return structuredClone(run.observation);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const pending = [...this.queue];
    for (const runId of pending) {
      const taskId = this.runs.get(runId)?.observation.task_id;
      if (taskId) await this.cancelRun(taskId, runId);
    }
    const active = [...this.runs.values()].find(
      (run) => run.observation.status === 'running',
    );
    if (active) {
      await this.cancelRun(active.observation.task_id, active.observation.run_id);
      const deadline = Date.now() + 5_000;
      while (
        !terminal(active.observation.status) &&
        Date.now() < deadline
      ) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
      if (!terminal(active.observation.status)) {
        this.signalRun(active, 'SIGKILL');
      }
    }
    const drainDeadline = Date.now() + 5_000;
    while (this.draining && Date.now() < drainDeadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }

  private async drain(): Promise<void> {
    if (this.draining || this.shuttingDown) return;
    this.draining = true;
    try {
      while (!this.shuttingDown) {
        const runId = this.queue.shift();
        if (!runId) break;
        const run = this.runs.get(runId);
        if (!run || run.observation.status !== 'queued') continue;
        await this.execute(run);
      }
    } finally {
      this.draining = false;
    }
  }

  private async execute(run: LiveRun): Promise<void> {
    run.observation.status = 'running';
    run.observation.started_at = new Date().toISOString();

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(this.shell, ['-lc', run.observation.command], {
        cwd: run.observation.cwd,
        env: process.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (cause) {
      await this.finish(run, {
        status: 'failed',
        error: errorFor(
          'SPAWN_FAILED',
          cause instanceof Error ? cause.message : 'The shell could not start.',
        ),
      });
      return;
    }
    run.child = child;
    run.observation.pid = child.pid ?? null;

    // Every listener is attached before the first `await` in this method.
    // `error`, `exit` and `close` are one-shot events: a command that finishes
    // while the "running" snapshot is still on its way to disk used to emit
    // them into an empty listener list, settle for nobody, and leave the run
    // stuck in `running` while the single concurrency slot stayed busy.
    const completion = new Promise<void>((resolvePromise) => {
      let settled = false;
      const settle = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
        spawnError?: Error,
      ) => {
        if (settled) return;
        settled = true;
        run.observation.exit_code = exitCode;
        run.observation.signal = signal;
        let result: FinishResult;
        if (spawnError) {
          result = {
            status: 'failed',
            error: errorFor('SPAWN_FAILED', spawnError.message),
          };
        } else if (run.requestedTerminalStatus === 'cancelled') {
          result = {
            status: 'cancelled',
            error: errorFor('CANCELLED', 'The command was cancelled.'),
          };
        } else if (run.requestedTerminalStatus === 'timed_out') {
          result = {
            status: 'timed_out',
            error: errorFor(
              'TIMEOUT',
              `The command exceeded ${run.timeoutSeconds} seconds.`,
            ),
          };
        } else if (exitCode === 0) {
          result = { status: 'succeeded', error: null };
        } else {
          result = {
            status: 'failed',
            error: errorFor(
              'COMMAND_EXIT_NONZERO',
              `The command exited with code ${exitCode ?? 'unknown'}.`,
            ),
          };
        }
        void this.finish(run, result).then(resolvePromise, resolvePromise);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return;
        const appended = appendBounded(
          run.observation.stdout,
          chunk,
          LOCAL_CONTROL_LIMITS.stdoutBytes,
        );
        run.observation.stdout = appended.value;
        run.observation.stdout_truncated ||= appended.truncated;
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (settled) return;
        const appended = appendBounded(
          run.observation.stderr,
          chunk,
          LOCAL_CONTROL_LIMITS.stderrBytes,
        );
        run.observation.stderr = appended.value;
        run.observation.stderr_truncated ||= appended.truncated;
      });

      run.timeout = setTimeout(() => {
        run.requestedTerminalStatus = 'timed_out';
        run.observation.error = errorFor(
          'TIMEOUT',
          `The command exceeded ${run.timeoutSeconds} seconds.`,
        );
        this.signalRun(run, 'SIGTERM');
        this.scheduleForceKill(run);
      }, run.timeoutSeconds * 1000);

      child.once('error', (cause) => settle(null, null, cause));
      child.once('exit', (code, signal) => {
        // The shell is gone, so no timeout can apply to it any more; only its
        // stdio may still be open.
        if (run.timeout) clearTimeout(run.timeout);
        run.timeout = null;
        run.stdioGrace = setTimeout(
          () => settle(code, signal),
          LOCAL_CONTROL_LIMITS.stdioGraceMilliseconds,
        );
        run.stdioGrace.unref();
      });
      child.once('close', (code, signal) => settle(code, signal));
    });

    const started = structuredClone(run.observation);
    await this.enqueueWrite(run, async () => {
      await this.storage.saveRun(started);
      await this.storage.appendAudit('started', started);
    });
    await completion;
  }

  private signalRun(run: LiveRun, signal: NodeJS.Signals): void {
    const pid = run.child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        run.child?.kill(signal);
      } catch {
        // The process may already have exited; the close handler owns terminal state.
      }
    }
  }

  private scheduleForceKill(run: LiveRun): void {
    if (run.forceKillTimeout) return;
    run.forceKillTimeout = setTimeout(() => this.signalRun(run, 'SIGKILL'), 3_000);
    run.forceKillTimeout.unref();
  }

  /**
   * Serialise the durable writes of a single run.
   *
   * `submit`, `execute` and `finish` each write a snapshot, and they overlap
   * whenever a command exits while an earlier snapshot is still on its way to
   * disk. Chaining keeps the run file and the audit log in causal order, so a
   * stale `running` snapshot can never land on top of the terminal one.
   */
  private enqueueWrite(run: LiveRun, write: () => Promise<void>): Promise<void> {
    const next = run.writes.then(write, write);
    run.writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async finish(run: LiveRun, result: FinishResult): Promise<void> {
    if (run.timeout) clearTimeout(run.timeout);
    if (run.forceKillTimeout) clearTimeout(run.forceKillTimeout);
    if (run.stdioGrace) clearTimeout(run.stdioGrace);
    run.timeout = null;
    run.forceKillTimeout = null;
    run.stdioGrace = null;
    const finished: LocalControlRunObservation = {
      ...run.observation,
      status: result.status,
      error: result.error,
      pid: null,
      finished_at: new Date().toISOString(),
    };

    // A terminal in-memory status is also the public polling contract. Publish
    // it only after the durable run file and audit line exist, so clients never
    // observe "finished" while its evidence is still being written.
    await this.enqueueWrite(run, async () => {
      await this.storage.saveRun(finished);
      await this.storage.appendAudit('finished', finished);
    });
    run.observation = finished;
    run.child = null;
  }
}
