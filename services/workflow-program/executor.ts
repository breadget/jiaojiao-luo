import { randomBytes } from 'node:crypto';
import type { CourseSource } from '../../lib/course-assistant-types';
import type {
  ProgramArtifact,
  ProgramJob,
  ProgramNodeSnapshot,
  ProgramResult,
  ProgramStartRequest,
} from '../../lib/workflow-program/types';
import {
  executeProgram,
  validateProgramInput,
  type ExecuteProgramOptions,
} from '../../lib/workflow-program/engine';
import { compileGraphToProgram } from '../../lib/workflow-graph/adapter/program';
import { createCourseRetriever } from './course-transport';
import { ProgramStorage, type StoredProgramJob } from './storage';
import {
  MAX_ARTIFACT_BYTES,
  ProgramServiceError,
  parseStartRequest,
  requestFingerprint,
  sanitizeJson,
  secretRedactor,
} from './safety';

type RunProgram = (
  plan: ProgramStartRequest['plan'],
  input: ProgramStartRequest['input'],
  options: ExecuteProgramOptions,
) => Promise<ProgramResult>;
type Pending = {
  request: ProgramStartRequest;
  redact: (text: string) => string;
};
type ExecutorOptions = {
  storage: ProgramStorage;
  run?: RunProgram;
  retrieveCourseSources?: (
    query: string,
    signal: AbortSignal,
  ) => Promise<CourseSource[]>;
  concurrency?: number;
  maxQueued?: number;
  timeoutMs?: number;
};
const terminal = (job: ProgramJob) =>
  ['completed', 'failed', 'cancelled'].includes(job.status);

export class ProgramExecutor {
  private readonly records = new Map<string, StoredProgramJob>();
  private readonly pending = new Map<string, Pending>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancellation = new Set<string>();
  private readonly queue: string[] = [];
  private readonly locks = new Map<string, Promise<unknown>>();
  private submission: Promise<unknown> = Promise.resolve();
  private running = 0;
  private stopping = false;
  private readonly runProgram: RunProgram;
  private readonly retrieve: (
    query: string,
    signal: AbortSignal,
  ) => Promise<CourseSource[]>;
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: ExecutorOptions) {
    this.runProgram = options.run ?? executeProgram;
    this.retrieve =
      options.retrieveCourseSources ??
      createCourseRetriever(process.env.COURSE_ASSISTANT_URL);
    this.concurrency = Math.max(1, Math.min(2, options.concurrency ?? 2));
    this.maxQueued = Math.max(0, Math.min(8, options.maxQueued ?? 8));
    this.timeoutMs = Math.max(
      1,
      Math.min(300_000, options.timeoutMs ?? 300_000),
    );
  }

  async init(): Promise<void> {
    await this.options.storage.init();
    for (const value of await this.options.storage.all()) {
      if (!terminal(value.job)) {
        value.job.status = 'failed';
        value.job.finishedAt = Date.now();
        value.job.result = null;
        value.job.error = {
          code: 'WORKER_RESTARTED',
          message: '程序服务已重启；请创建新任务重新运行。',
        };
        this.finishNodes(value.job, value.job.error.message);
        await this.options.storage.write(value);
      }
      this.records.set(value.job.id, value);
    }
  }

  private lock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const promise = previous.catch(() => undefined).then(operation);
    this.locks.set(id, promise);
    void promise
      .finally(() => {
        if (this.locks.get(id) === promise) this.locks.delete(id);
      })
      .catch(() => undefined);
    return promise;
  }

  private async update(
    id: string,
    change: (job: ProgramJob) => void,
  ): Promise<ProgramJob> {
    return this.lock(id, async () => {
      const current = this.records.get(id);
      if (!current)
        throw new ProgramServiceError('NOT_FOUND', '程序任务不存在。', 404);
      const value = structuredClone(current);
      change(value.job);
      await this.options.storage.write(value);
      this.records.set(id, value);
      return structuredClone(value.job);
    });
  }

  async submit(value: unknown): Promise<ProgramJob> {
    const operation = this.submission
      .catch(() => undefined)
      .then(async () => {
        if (this.stopping)
          throw new ProgramServiceError(
            'WORKER_STOPPING',
            '程序服务正在停止。',
            503,
          );
        const request = parseStartRequest(value);
        const fingerprint = requestFingerprint(request);
        const existing = this.records.get(request.id);
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            throw new ProgramServiceError(
              'JOB_CONFLICT',
              '任务编号已用于不同的程序输入。',
              409,
            );
          return structuredClone(existing.job);
        }
        const assertDispatchLive = () => {
          if (
            request.dispatchExpiresAt !== undefined &&
            Date.now() >= request.dispatchExpiresAt
          )
            throw new ProgramServiceError(
              'DISPATCH_EXPIRED',
              '程序派发已过期，请重新运行。',
              408,
            );
        };
        assertDispatchLive();
        const compiled = await compileGraphToProgram(request.plan.graph, {
          workflowId: request.workflowId,
          version: request.workflowVersion,
        });
        if (!compiled.ok || !compiled.plan)
          throw new ProgramServiceError(
            'INVALID_PLAN',
            '程序画布未通过执行验证。',
          );
        // The service accepts a canonical schedule only; it never trusts a supplied execution list.
        request.plan = compiled.plan;
        try {
          request.input = validateProgramInput(
            request.plan.inputFields,
            request.input,
          );
        } catch {
          throw new ProgramServiceError(
            'INVALID_INPUT',
            '程序输入无效，请检查必填项和字段类型。',
          );
        }
        const queued = this.queue.filter(
          (id) => this.records.get(id)?.job.status === 'queued',
        ).length;
        if (
          queued >=
          this.maxQueued + Math.max(0, this.concurrency - this.running)
        )
          throw new ProgramServiceError(
            'QUEUE_FULL',
            '程序任务队列已满，请稍后重试。',
            429,
          );
        const redact = secretRedactor([request.llm.apiKey]);
        const nodes: Record<string, ProgramNodeSnapshot> = {};
        for (const node of request.plan.graph.nodes) {
          nodes[redact(node.id)] = {
            id: redact(node.id),
            name: redact(node.name),
            state: node.disabled ? 'skipped' : 'waiting',
          };
        }
        const job: ProgramJob = {
          id: request.id,
          workflowId: redact(request.workflowId),
          workflowVersion: request.workflowVersion,
          versionId: redact(request.versionId),
          status: 'queued',
          input: sanitizeJson(request.input, redact) as ProgramJob['input'],
          nodes,
          result: null,
          artifacts: [],
          createdAt: Date.now(),
          startedAt: null,
          finishedAt: null,
        };
        const stored = { fingerprint, job };
        assertDispatchLive();
        await this.options.storage.write(stored);
        this.records.set(job.id, stored);
        this.pending.set(job.id, { request, redact });
        this.queue.push(job.id);
        setImmediate(() => this.pump());
        return structuredClone(job);
      });
    this.submission = operation;
    return operation;
  }

  get(id: string): ProgramJob | null {
    const job = this.records.get(id)?.job;
    return job ? structuredClone(job) : null;
  }

  async cancel(id: string): Promise<ProgramJob> {
    // Abort synchronously before waiting for a pending snapshot write.
    if (this.records.has(id) && !terminal(this.records.get(id)!.job))
      this.cancellation.add(id);
    this.controllers
      .get(id)
      ?.abort(new DOMException('Program cancelled', 'AbortError'));
    const result = await this.update(id, (job) => {
      if (terminal(job)) return;
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      job.result = null;
      job.error = { code: 'CANCELLED', message: '程序任务已取消。' };
      this.finishNodes(job, job.error.message);
    });
    this.pending.delete(id);
    return result;
  }

  private finishNodes(job: ProgramJob, error: string): void {
    for (const node of Object.values(job.nodes)) {
      if (node.state === 'waiting') node.state = 'skipped';
      else if (node.state === 'running') {
        node.state = 'error';
        node.error = error;
        node.finishedAt = Date.now();
      }
    }
  }

  private pump(): void {
    if (this.stopping) return;
    while (this.running < this.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      const pending = this.pending.get(id);
      if (!pending || this.records.get(id)?.job.status !== 'queued') continue;
      this.running += 1;
      void this.execute(id, pending)
        .catch(() => undefined)
        .finally(() => {
          this.running -= 1;
          this.pending.delete(id);
          this.controllers.delete(id);
          this.pump();
        });
    }
  }

  private async execute(id: string, pending: Pending): Promise<void> {
    const { request, redact } = pending;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    let timeout = false;
    const timer = setTimeout(() => {
      timeout = true;
      controller.abort(
        new DOMException('Program deadline exceeded', 'TimeoutError'),
      );
    }, this.timeoutMs);
    const assertRunning = () => {
      if (
        controller.signal.aborted ||
        this.cancellation.has(id) ||
        this.records.get(id)?.job.status !== 'running'
      )
        throw (
          controller.signal.reason ??
          new DOMException('Program cancelled', 'AbortError')
        );
    };
    let rejectAbort: (() => void) | undefined;
    try {
      await this.update(id, (job) => {
        if (job.status !== 'queued') return;
        job.status = 'running';
        job.startedAt = Date.now();
      });
      assertRunning();
      const options: ExecuteProgramOptions = {
        llm: request.llm,
        signal: controller.signal,
        retrieveCourseSources: this.retrieve,
        onNode: async (snapshot) => {
          assertRunning();
          await this.update(id, (job) => {
            assertRunning();
            const safeId = redact(snapshot.id);
            if (!Object.hasOwn(job.nodes, safeId))
              throw new ProgramServiceError(
                'INVALID_NODE',
                '程序节点不存在。',
                500,
              );
            const node = {
              id: snapshot.id,
              name: snapshot.name,
              state: snapshot.state,
              ...(snapshot.startedAt === undefined
                ? {}
                : { startedAt: snapshot.startedAt }),
              ...(snapshot.finishedAt === undefined
                ? {}
                : { finishedAt: snapshot.finishedAt }),
              ...(snapshot.input === undefined
                ? {}
                : { input: snapshot.input }),
              ...(snapshot.output === undefined
                ? {}
                : { output: snapshot.output }),
              ...(snapshot.error === undefined
                ? {}
                : { error: snapshot.error }),
            };
            job.nodes[safeId] = sanitizeJson(
              node,
              redact,
            ) as ProgramNodeSnapshot;
          });
        },
        writeArtifact: async (input) => {
          assertRunning();
          const name = redact(input.name);
          if (
            !name ||
            name.length > 180 ||
            /[\\/]/.test(name) ||
            Array.from(name).some(
              (character) =>
                character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
            ) ||
            name === '.' ||
            name === '..' ||
            !['text/plain', 'text/markdown'].includes(input.mimeType) ||
            typeof input.content !== 'string'
          )
            throw new ProgramServiceError(
              'INVALID_ARTIFACT',
              '程序文件名称或格式无效。',
              500,
            );
          const content = redact(input.content);
          const artifact: ProgramArtifact = {
            id: `artifact_${randomBytes(16).toString('hex')}`,
            name,
            mimeType: input.mimeType,
            sizeBytes: Buffer.byteLength(content, 'utf8'),
          };
          if (artifact.sizeBytes > MAX_ARTIFACT_BYTES)
            throw new ProgramServiceError(
              'OUTPUT_TOO_LARGE',
              '程序文件过大。',
              500,
            );
          await this.lock(id, async () => {
            assertRunning();
            const value = structuredClone(this.records.get(id)!);
            if (
              value.job.artifacts.length >= 10 ||
              value.job.artifacts.reduce(
                (sum, item) => sum + item.sizeBytes,
                0,
              ) +
                artifact.sizeBytes >
                5 * MAX_ARTIFACT_BYTES
            )
              throw new ProgramServiceError(
                'OUTPUT_TOO_LARGE',
                '程序文件总量过大。',
                500,
              );
            await this.options.storage.writeArtifact(id, artifact, content);
            assertRunning();
            value.job.artifacts.push(artifact);
            await this.options.storage.write(value);
            this.records.set(id, value);
          });
          return artifact;
        },
      };
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () =>
          reject(
            controller.signal.reason ??
              new DOMException('Cancelled', 'AbortError'),
          );
        controller.signal.addEventListener('abort', rejectAbort, {
          once: true,
        });
        if (controller.signal.aborted) rejectAbort();
      });
      const result = await Promise.race([
        this.runProgram(request.plan, request.input, options),
        aborted,
      ]);
      assertRunning();
      await this.update(id, (job) => {
        assertRunning();
        job.status = 'completed';
        job.finishedAt = Date.now();
        job.result = sanitizeJson(
          {
            text: result.text,
            sources: result.sources,
            ...(result.model
              ? {
                  model: {
                    provider: result.model.provider,
                    model: result.model.model,
                  },
                }
              : {}),
            ...(result.data === undefined ? {} : { data: result.data }),
          },
          redact,
        ) as ProgramResult;
      });
    } catch (cause) {
      await this.update(id, (job) => {
        if (terminal(job)) return;
        const cancelled = this.stopping || this.cancellation.has(id);
        job.status = cancelled ? 'cancelled' : 'failed';
        job.finishedAt = Date.now();
        job.result = null;
        const code = timeout
          ? 'PROGRAM_TIMEOUT'
          : cause &&
              typeof cause === 'object' &&
              'code' in cause &&
              typeof cause.code === 'string' &&
              /^[A-Z_]{1,80}$/.test(cause.code)
            ? cause.code
            : 'PROGRAM_FAILED';
        job.error = {
          code: cancelled ? 'CANCELLED' : redact(code),
          message: cancelled
            ? '程序任务已取消。'
            : timeout
              ? '程序运行超过五分钟限制。'
              : redact(
                  cause instanceof Error ? cause.message : '程序运行失败。',
                ).slice(0, 2000),
        };
        this.finishNodes(job, job.error.message);
      });
    } finally {
      clearTimeout(timer);
      if (rejectAbort)
        controller.signal.removeEventListener('abort', rejectAbort);
      // The only retained request reference is removed by pump's finally block.
      request.llm.apiKey = '';
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    await this.submission.catch(() => undefined);
    await Promise.all(
      [...this.records.values()]
        .filter((value) => !terminal(value.job))
        .map((value) => this.cancel(value.job.id)),
    );
  }
}
