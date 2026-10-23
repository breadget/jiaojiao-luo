import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type {
  SandboxBackend,
  SandboxRunRequest,
} from '@/services/python-executor/docker-runner';
import { PythonExecutor } from '@/services/python-executor/executor';
import { createExecutorHttpServer } from '@/services/python-executor/server';
import { ExecutorStorage } from '@/services/python-executor/storage';

const TOKEN = 'test-python-executor-token-000000000000';

class HttpFakeSandbox implements SandboxBackend {
  waitForCancellation = false;

  async preflight() {}

  async run(request: SandboxRunRequest) {
    if (this.waitForCancellation) {
      await new Promise<void>((resolvePromise) => {
        if (request.signal?.aborted) resolvePromise();
        else
          request.signal?.addEventListener('abort', () => resolvePromise(), {
            once: true,
          });
      });
      return {
        kind: 'cancelled' as const,
        exitCode: 137,
        stdout: { text: '', truncated: false, seenBytes: 0 },
        stderr: { text: '', truncated: false, seenBytes: 0 },
        durationMs: 10,
        cpuTimeMs: 2,
        peakMemoryBytes: 2048,
        cleanupConfirmed: true,
        errorMessage: null,
      };
    }
    await writeFile(join(request.outputDir, 'summary.csv'), 'sum\n6\n');
    return {
      kind: 'exited' as const,
      exitCode: 0,
      stdout: { text: '6\n', truncated: false, seenBytes: 2 },
      stderr: { text: '', truncated: false, seenBytes: 0 },
      durationMs: 10,
      cpuTimeMs: 2,
      peakMemoryBytes: 2048,
      cleanupConfirmed: true,
      errorMessage: null,
    };
  }

  async validatePng() {}

  async validateXlsx() {}

  async validatePdf() {}

  async validateDocx() {}

  async validatePptx() {}
}

describe('Python Executor internal HTTP API', () => {
  let root = '';
  let baseUrl = '';
  let server: ReturnType<typeof createExecutorHttpServer>;
  let sandbox: HttpFakeSandbox;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'urtoris-executor-http-'));
    sandbox = new HttpFakeSandbox();
    const executor = new PythonExecutor({
      storage: new ExecutorStorage(root),
      sandbox,
      sandboxImage: 'urtoris/python-executor:test',
    });
    await executor.init();
    server = createExecutorHttpServer({ executor, token: TOKEN });
    await new Promise<void>((resolvePromise) =>
      server.listen(0, '127.0.0.1', resolvePromise),
    );
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolvePromise, reject) =>
      server.close((cause) => (cause ? reject(cause) : resolvePromise())),
    );
    await rm(root, { recursive: true, force: true });
  });

  it('rejects requests without the internal bearer token', async () => {
    const response = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'UNAUTHORIZED');
  });

  it('uploads by file_id, executes once, reads status, and downloads an artifact', async () => {
    const taskId = 'task_http';
    const upload = await fetch(`${baseUrl}/v1/files`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Urtoris-Task-Id': taskId,
        'X-Urtoris-File-Name': 'numbers.csv',
      },
      body: 'value\n1\n2\n3\n',
    });
    assert.equal(upload.status, 201);
    const uploaded = (await upload.json()) as { file: { file_id: string } };
    assert.match(uploaded.file.file_id, /^file_[a-f0-9]{32}$/);

    const executed = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        protocol: 'urtoris.python-executor.v1',
        task_id: taskId,
        idempotency_key: `${taskId}:attempt:1`,
        attempt: 1,
        code: 'print(6)',
        input_files: [
          {
            file_id: uploaded.file.file_id,
            mount_name: 'numbers.csv',
          },
        ],
        timeout_seconds: 30,
      }),
    });
    assert.equal(executed.status, 202);
    const accepted = (await executed.json()) as {
      run_id: string;
      status: string;
      artifacts: Array<{ artifact_id: string }>;
    };
    assert.equal(accepted.status, 'queued');
    assert.deepEqual(accepted.artifacts, []);
    assert.equal(
      executed.headers.get('Location'),
      `/v1/runs/${accepted.run_id}`,
    );

    let run = accepted;
    for (let index = 0; index < 100; index += 1) {
      const read = await fetch(`${baseUrl}/v1/runs/${accepted.run_id}`, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'X-Urtoris-Task-Id': taskId,
        },
      });
      assert.equal(read.status, 200);
      run = (await read.json()) as typeof run;
      if (run.status !== 'queued' && run.status !== 'running') break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    assert.equal(run.artifacts.length, 1);
    assert.equal(run.status, 'succeeded');

    const listed = await fetch(`${baseUrl}/v1/runs`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Urtoris-Task-Id': taskId,
      },
    });
    const listing = (await listed.json()) as {
      runs: Array<{ run_id: string }>;
    };
    assert.deepEqual(
      listing.runs.map((candidate) => candidate.run_id),
      [accepted.run_id],
    );

    const read = await fetch(`${baseUrl}/v1/runs/${accepted.run_id}`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Urtoris-Task-Id': taskId,
      },
    });
    assert.equal(read.status, 200);

    const artifact = await fetch(
      `${baseUrl}/v1/artifacts/${run.artifacts[0].artifact_id}`,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'X-Urtoris-Task-Id': taskId,
          'X-Urtoris-Run-Id': accepted.run_id,
        },
      },
    );
    assert.equal(artifact.status, 200);
    assert.equal(artifact.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(await artifact.text(), 'sum\n6\n');
  });

  it('accepts DELETE cancellation and exposes killed/CANCELLED on later GET', async () => {
    sandbox.waitForCancellation = true;
    const taskId = 'task_http_cancel';
    const submitted = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        protocol: 'urtoris.python-executor.v1',
        task_id: taskId,
        idempotency_key: `${taskId}:attempt:1`,
        attempt: 1,
        code: 'while True:\n    pass',
        input_files: [],
        profile: 'long',
        timeout_seconds: 600,
      }),
    });
    assert.equal(submitted.status, 202);
    const accepted = (await submitted.json()) as { run_id: string };

    for (let index = 0; index < 100; index += 1) {
      const status = await fetch(`${baseUrl}/v1/runs/${accepted.run_id}`, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'X-Urtoris-Task-Id': taskId,
        },
      });
      const current = (await status.json()) as { status: string };
      if (current.status === 'running') break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }

    const cancelled = await fetch(`${baseUrl}/v1/runs/${accepted.run_id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Urtoris-Task-Id': taskId,
      },
    });
    assert.equal(cancelled.status, 202);

    type TerminalBody = { status: string; error?: { code?: string } };
    let terminal: TerminalBody | null = null;
    for (let index = 0; index < 100; index += 1) {
      const status = await fetch(`${baseUrl}/v1/runs/${accepted.run_id}`, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'X-Urtoris-Task-Id': taskId,
        },
      });
      terminal = (await status.json()) as TerminalBody;
      if (terminal?.status === 'killed') break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    assert.equal(terminal?.status, 'killed');
    assert.equal(terminal?.error?.code, 'CANCELLED');
    sandbox.waitForCancellation = false;
  });
});
