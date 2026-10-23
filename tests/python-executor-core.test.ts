import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type {
  SandboxBackend,
  SandboxRunOutcome,
  SandboxRunRequest,
} from '@/services/python-executor/docker-runner';
import { PythonExecutor } from '@/services/python-executor/executor';
import {
  EXECUTOR_LIMITS,
  EXECUTOR_PROFILES,
  PYTHON_EXECUTOR_PROTOCOL,
  ToolRequestError,
  type PythonRunResult,
  validateRunPythonRequest,
} from '@/services/python-executor/protocol';
import { ExecutorStorage } from '@/services/python-executor/storage';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

class FakeSandbox implements SandboxBackend {
  calls = 0;
  waitForCancellation = false;
  outputFiles = new Map<string, string | Uint8Array>();
  outcome: SandboxRunOutcome = {
    kind: 'exited',
    exitCode: 0,
    stdout: { text: 'ok\n', truncated: false, seenBytes: 3 },
    stderr: { text: '', truncated: false, seenBytes: 0 },
    durationMs: 12,
    cpuTimeMs: 4,
    peakMemoryBytes: 1024,
    cleanupConfirmed: true,
    errorMessage: null,
  };

  async preflight() {}

  async run(request: SandboxRunRequest) {
    this.calls += 1;
    if (this.waitForCancellation) {
      await new Promise<void>((resolvePromise) => {
        if (request.signal?.aborted) resolvePromise();
        else
          request.signal?.addEventListener('abort', () => resolvePromise(), {
            once: true,
          });
      });
      return {
        ...this.outcome,
        kind: 'cancelled' as const,
        exitCode: 137,
      };
    }
    for (const [name, value] of this.outputFiles) {
      await writeFile(join(request.outputDir, name), value);
    }
    return this.outcome;
  }

  async validatePng() {}

  async validateXlsx() {}

  async validatePdf() {}

  async validateDocx() {}

  async validatePptx() {}
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'urtoris-executor-test-'));
  temporaryRoots.push(root);
  const storage = new ExecutorStorage(root);
  const sandbox = new FakeSandbox();
  const executor = new PythonExecutor({
    storage,
    sandbox,
    sandboxImage: 'urtoris/python-executor:test',
  });
  await executor.init();
  return { root, storage, sandbox, executor };
}

function request(
  taskId: string,
  attempt = 1,
  overrides: Record<string, unknown> = {},
) {
  return {
    protocol: PYTHON_EXECUTOR_PROTOCOL,
    task_id: taskId,
    idempotency_key: `${taskId}:attempt:${attempt}`,
    attempt,
    code: 'print("ok")',
    input_files: [],
    timeout_seconds: 30,
    ...overrides,
  };
}

async function submitAndWait(
  executor: PythonExecutor,
  value: ReturnType<typeof request>,
) {
  const accepted = await executor.submit(value);
  assert.equal(accepted.status, 'queued');
  const terminal = await executor.waitForRun(accepted.task_id, accepted.run_id);
  assert.ok(terminal);
  return terminal;
}

describe('Python Executor core', () => {
  it('runs once, publishes a valid CSV, and stores traceable logs', async () => {
    const { root, sandbox, executor } = await fixture();
    sandbox.outputFiles.set('summary.csv', 'sum\n6\n');
    const result = await submitAndWait(executor, request('task_success'));

    assert.equal(result.status, 'succeeded');
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, 'ok\n');
    assert.equal(result.artifacts.length, 1);
    assert.equal(sandbox.calls, 1);
    const runRoot = join(root, 'tasks', 'task_success', 'runs', result.run_id);
    assert.equal(
      await readFile(join(runRoot, 'source', 'main.py'), 'utf8'),
      'print("ok")',
    );
    assert.equal(
      await readFile(join(runRoot, 'logs', 'stdout.txt'), 'utf8'),
      'ok\n',
    );
    const metadata = JSON.parse(
      await readFile(join(runRoot, 'metadata.json'), 'utf8'),
    ) as {
      cleanup_status: string;
      code_sha256: string;
      state_history: unknown[];
    };
    assert.equal(metadata.cleanup_status, 'succeeded');
    assert.match(metadata.code_sha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(metadata.state_history.length, 3);
  });

  it('maps syntax/process failures and never publishes partial output', async () => {
    const { sandbox, executor } = await fixture();
    sandbox.outputFiles.set('partial.csv', 'value\n1\n');
    sandbox.outcome = {
      ...sandbox.outcome,
      kind: 'exited',
      exitCode: 1,
      stderr: {
        text: 'SyntaxError: invalid syntax\n',
        truncated: false,
        seenBytes: 28,
      },
    };
    const result = await submitAndWait(executor, request('task_syntax'));
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'PROCESS_EXIT_NONZERO');
    assert.equal(result.error?.retryable, true);
    assert.deepEqual(result.artifacts, []);
  });

  it('maps timeout and OOM outcomes to non-retryable terminal states', async () => {
    const timeoutFixture = await fixture();
    timeoutFixture.sandbox.outcome = {
      ...timeoutFixture.sandbox.outcome,
      kind: 'timed_out',
      exitCode: 137,
    };
    const timeout = await submitAndWait(
      timeoutFixture.executor,
      request('task_timeout'),
    );
    assert.equal(timeout.status, 'timed_out');
    assert.equal(timeout.error?.code, 'TIMEOUT');
    assert.equal(timeout.error?.retryable, false);
    await assert.rejects(
      () => timeoutFixture.executor.submit(request('task_timeout', 2)),
      (cause: unknown) =>
        cause instanceof ToolRequestError && cause.code === 'ATTEMPT_LIMIT',
    );

    const memoryFixture = await fixture();
    memoryFixture.sandbox.outcome = {
      ...memoryFixture.sandbox.outcome,
      kind: 'memory_limit',
      exitCode: 137,
    };
    const memory = await submitAndWait(
      memoryFixture.executor,
      request('task_memory'),
    );
    assert.equal(memory.status, 'killed');
    assert.equal(memory.error?.code, 'MEMORY_LIMIT');
    assert.equal(memory.error?.retryable, false);
  });

  it('uses opaque task-scoped file IDs and mounts only the requested name', async () => {
    const { executor } = await fixture();
    const stored = await executor.storeInput({
      taskId: 'task_files',
      name: 'source.csv',
      bytes: Buffer.from('value\n1\n'),
    });
    const result = await submitAndWait(
      executor,
      request('task_files', 1, {
        input_files: [{ file_id: stored.file_id, mount_name: 'renamed.csv' }],
      }),
    );
    assert.equal(result.status, 'succeeded');

    await assert.rejects(
      () =>
        executor.submit(
          request('task_other', 1, {
            input_files: [
              { file_id: stored.file_id, mount_name: 'source.csv' },
            ],
          }),
        ),
      (cause: unknown) =>
        cause instanceof ToolRequestError && cause.code === 'FILE_UNAVAILABLE',
    );
  });

  it('replays an identical idempotency key and rejects a changed payload', async () => {
    const { sandbox, executor } = await fixture();
    const original = request('task_idempotent');
    const first = await submitAndWait(executor, original);
    const replay = await executor.submit(original);
    assert.equal(replay.run_id, first.run_id);
    assert.equal(sandbox.calls, 1);

    await assert.rejects(
      () => executor.submit({ ...original, code: 'print("changed")' }),
      (cause: unknown) =>
        cause instanceof ToolRequestError &&
        cause.code === 'IDEMPOTENCY_CONFLICT',
    );
  });

  it('cancels running work and finalizes a queued cancellation immediately', async () => {
    const { sandbox, executor } = await fixture();
    sandbox.waitForCancellation = true;

    const first = await executor.submit(request('task_cancel_running'));
    for (let index = 0; index < 100; index += 1) {
      const current = await executor.getRun(first.task_id, first.run_id);
      if (current?.status === 'running') break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
    }
    assert.equal(
      (await executor.getRun(first.task_id, first.run_id))?.status,
      'running',
    );

    const second = await executor.submit(request('task_cancel_queued'));
    const queuedCancellation = await executor.cancelRun(
      second.task_id,
      second.run_id,
    );
    assert.equal(queuedCancellation?.status, 'killed');
    assert.equal(queuedCancellation?.error?.code, 'CANCELLED');
    assert.equal(queuedCancellation?.started_at, null);

    const cancellationAccepted = await executor.cancelRun(
      first.task_id,
      first.run_id,
    );
    assert.equal(cancellationAccepted?.status, 'running');
    const terminal = await executor.waitForRun(first.task_id, first.run_id);
    assert.equal(terminal?.status, 'killed');
    assert.equal(terminal?.error?.code, 'CANCELLED');
    assert.equal(terminal?.cleanup_status, 'succeeded');

    const queuedTerminal = await executor.waitForRun(
      second.task_id,
      second.run_id,
    );
    assert.equal(queuedTerminal?.status, 'killed');
    assert.equal(sandbox.calls, 1, '已取消的排队任务不应启动沙箱');
  });

  it('enforces three sequential attempts and links their run IDs', async () => {
    const { sandbox, executor } = await fixture();
    sandbox.outcome = {
      ...sandbox.outcome,
      exitCode: 1,
      stderr: { text: 'ValueError: first', truncated: false, seenBytes: 17 },
    };
    const first = await submitAndWait(executor, request('task_attempts', 1));
    sandbox.outcome = {
      ...sandbox.outcome,
      stderr: { text: 'TypeError: second', truncated: false, seenBytes: 17 },
    };
    const second = await submitAndWait(executor, request('task_attempts', 2));
    sandbox.outcome = {
      ...sandbox.outcome,
      stderr: { text: 'KeyError: third', truncated: false, seenBytes: 15 },
    };
    const third = await submitAndWait(executor, request('task_attempts', 3));
    assert.equal(second.parent_run_id, first.run_id);
    assert.equal(third.parent_run_id, second.run_id);
    await assert.rejects(
      () =>
        executor.submit(
          request('task_attempts', 3, {
            idempotency_key: 'task_attempts:extra',
          }),
        ),
      (cause: unknown) =>
        cause instanceof ToolRequestError && cause.code === 'ATTEMPT_LIMIT',
    );
  });

  it('stops before a third attempt when the normalized error repeats', async () => {
    const { sandbox, executor } = await fixture();
    sandbox.outcome = {
      ...sandbox.outcome,
      exitCode: 1,
      stderr: {
        text: 'Traceback line 4\nValueError: bad input',
        truncated: false,
        seenBytes: 38,
      },
    };
    await submitAndWait(executor, request('task_repeat', 1));
    sandbox.outcome = {
      ...sandbox.outcome,
      stderr: {
        text: 'Traceback line 9\nValueError: bad input',
        truncated: false,
        seenBytes: 38,
      },
    };
    await submitAndWait(executor, request('task_repeat', 2));
    await assert.rejects(
      () => executor.submit(request('task_repeat', 3)),
      (cause: unknown) =>
        cause instanceof ToolRequestError && cause.code === 'ATTEMPT_LIMIT',
    );
    assert.equal(sandbox.calls, 2);
  });

  it('publishes a validated XLSX and rejects a forged spreadsheet', async () => {
    const valid = await fixture();
    valid.sandbox.outputFiles.set(
      'book.xlsx',
      'PK\u0003\u0004[Content_Types].xml',
    );
    const ok = await submitAndWait(valid.executor, request('task_xlsx_ok'));
    assert.equal(ok.status, 'succeeded');
    assert.equal(ok.artifacts.length, 1);
    assert.equal(ok.artifacts[0]?.name, 'book.xlsx');
    assert.match(ok.artifacts[0]?.mime_type ?? '', /spreadsheetml/);

    const forged = await fixture();
    forged.sandbox.outputFiles.set('book.xlsx', 'not a zip at all');
    const rejected = await submitAndWait(
      forged.executor,
      request('task_xlsx_bad'),
    );
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.error?.code, 'ARTIFACT_REJECTED');
    assert.deepEqual(rejected.artifacts, []);
  });

  it('publishes a validated PDF and rejects a forged document', async () => {
    const valid = await fixture();
    valid.sandbox.outputFiles.set(
      'hello.pdf',
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
    );
    const ok = await submitAndWait(valid.executor, request('task_pdf_ok'));
    assert.equal(ok.status, 'succeeded');
    assert.equal(ok.artifacts.length, 1);
    assert.equal(ok.artifacts[0]?.name, 'hello.pdf');
    assert.equal(ok.artifacts[0]?.mime_type, 'application/pdf');

    const forged = await fixture();
    forged.sandbox.outputFiles.set('hello.pdf', 'not a pdf at all');
    const rejected = await submitAndWait(
      forged.executor,
      request('task_pdf_bad'),
    );
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.error?.code, 'ARTIFACT_REJECTED');
    assert.deepEqual(rejected.artifacts, []);
  });

  it('publishes validated DOCX and PPTX artifacts', async () => {
    const { sandbox, executor } = await fixture();
    const ooxmlEnvelope = 'PK\u0003\u0004[Content_Types].xml';
    sandbox.outputFiles.set('brief.docx', ooxmlEnvelope);
    sandbox.outputFiles.set('slides.pptx', ooxmlEnvelope);

    const result = await submitAndWait(executor, request('task_office_ok'));
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.artifacts.map((artifact) => artifact.name).sort(), [
      'brief.docx',
      'slides.pptx',
    ]);
    assert.match(
      result.artifacts.find((artifact) => artifact.name === 'brief.docx')
        ?.mime_type ?? '',
      /wordprocessingml/,
    );
    assert.match(
      result.artifacts.find((artifact) => artifact.name === 'slides.pptx')
        ?.mime_type ?? '',
      /presentationml/,
    );
  });

  it('rejects the whole artifact set if any output is unsafe', async () => {
    const { sandbox, executor } = await fixture();
    sandbox.outputFiles.set('good.csv', 'value\n1\n');
    sandbox.outputFiles.set('bad.html', '<script>alert(1)</script>');
    const result = await submitAndWait(executor, request('task_artifacts'));
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'ARTIFACT_REJECTED');
    assert.deepEqual(result.artifacts, []);
  });

  it('cannot report success when container cleanup was not confirmed', async () => {
    const { sandbox, executor } = await fixture();
    sandbox.outputFiles.set('result.csv', 'value\n1\n');
    sandbox.outcome = {
      ...sandbox.outcome,
      cleanupConfirmed: false,
      errorMessage: 'container still exists',
    };
    const result = await submitAndWait(executor, request('task_cleanup'));
    assert.equal(result.status, 'failed');
    assert.equal(result.cleanup_status, 'failed');
    assert.equal(result.error?.code, 'WORKER_ERROR');
    assert.deepEqual(result.artifacts, []);
  });

  it('recovers an interrupted running record as failed after worker restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'urtoris-executor-test-'));
    temporaryRoots.push(root);
    const firstStorage = new ExecutorStorage(root);
    const firstExecutor = new PythonExecutor({
      storage: firstStorage,
      sandbox: new FakeSandbox(),
      sandboxImage: 'urtoris/python-executor:test',
    });
    await firstExecutor.init();

    const taskId = 'task_restart_recovery';
    const runId = `run_${'a'.repeat(32)}`;
    const createdAt = '2026-09-15T00:00:00.000Z';
    const startedAt = '2026-09-15T00:00:01.000Z';
    const recoveredAt = new Date('2026-09-15T00:01:00.000Z');
    const normalizedRequest = validateRunPythonRequest(
      request(taskId, 1, { profile: 'long', timeout_seconds: 600 }),
    );
    const interrupted: PythonRunResult = {
      protocol: PYTHON_EXECUTOR_PROTOCOL,
      task_id: taskId,
      run_id: runId,
      attempt: 1,
      parent_run_id: null,
      profile: 'long',
      status: 'running',
      exit_code: null,
      stdout: '',
      stderr: '',
      stdout_truncated: false,
      stderr_truncated: false,
      artifacts: [],
      error: null,
      metrics: {
        queued_ms: 1_000,
        duration_ms: null,
        cpu_time_ms: null,
        peak_memory_bytes: null,
      },
      limits: {
        timeout_seconds: 600,
        cpu_count: EXECUTOR_PROFILES.long.cpuCount,
        memory_bytes: EXECUTOR_PROFILES.long.memoryBytes,
        processes: EXECUTOR_LIMITS.processes,
        stdout_bytes: EXECUTOR_LIMITS.streamBytes,
        stderr_bytes: EXECUTOR_LIMITS.streamBytes,
      },
      created_at: createdAt,
      started_at: startedAt,
      finished_at: null,
      cleanup_status: 'pending',
    };
    const paths = await firstStorage.createRun(
      normalizedRequest,
      runId,
      interrupted,
      {
        state_history: [
          { status: 'queued', at: createdAt },
          { status: 'running', at: startedAt },
        ],
        cleanup_status: 'pending',
      },
    );
    await writeFile(join(paths.stageOutputDir, 'partial.csv'), 'value\n1\n');
    await writeFile(join(paths.artifactRoot, 'partial.csv'), 'value\n1\n');
    await firstExecutor.shutdown();

    const recoveredSandbox = new FakeSandbox();
    const recoveredExecutor = new PythonExecutor({
      storage: new ExecutorStorage(root),
      sandbox: recoveredSandbox,
      sandboxImage: 'urtoris/python-executor:test',
      now: () => recoveredAt,
    });
    await recoveredExecutor.init();

    const result = await recoveredExecutor.getRun(taskId, runId);
    assert.equal(result?.status, 'failed');
    assert.equal(result?.error?.code, 'WORKER_ERROR');
    assert.equal(result?.error?.retryable, false);
    assert.equal(result?.finished_at, recoveredAt.toISOString());
    assert.equal(result?.cleanup_status, 'succeeded');
    assert.deepEqual(result?.artifacts, []);
    assert.deepEqual(await readdir(paths.artifactRoot), []);
    await assert.rejects(
      () => stat(paths.stageDir),
      (cause: unknown) =>
        cause instanceof Error && 'code' in cause && cause.code === 'ENOENT',
    );
    const audit = JSON.parse(await readFile(paths.metadataPath, 'utf8')) as {
      state_history: Array<{ status: string }>;
      internal_error: string;
      cleanup_status: string;
    };
    assert.equal(audit.state_history.at(-1)?.status, 'failed');
    assert.match(audit.internal_error, /restarted/i);
    assert.equal(audit.cleanup_status, 'succeeded');
    assert.equal(recoveredSandbox.calls, 0);
    await recoveredExecutor.shutdown();
  });
});
