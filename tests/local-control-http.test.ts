import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import {
  LOCAL_CONTROL_PROTOCOL,
  type LocalControlRunObservation,
} from '@/lib/local-control-protocol';
import { LocalControlExecutor } from '../services/local-control/executor';
import { createLocalControlHttpServer } from '../services/local-control/server';
import { LocalControlStorage } from '../services/local-control/storage';

const roots: string[] = [];
const executors: LocalControlExecutor[] = [];
const servers: Server[] = [];

/** 与 executor 用例同样处理：macOS 用 zsh，Linux CI runner 上没有 zsh。 */
const TEST_SHELL = existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash';

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
          server.closeIdleConnections();
        }),
    ),
  );
  for (const executor of executors.splice(0)) await executor.shutdown();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'urtoris-local-http-'));
  roots.push(root);
  const executor = new LocalControlExecutor({
    storage: new LocalControlStorage(join(root, 'state')),
    shell: TEST_SHELL,
    defaultCwd: root,
    maximumQueuedRuns: 2,
  });
  await executor.init();
  executors.push(executor);
  const token = 'test-token-that-is-at-least-32-characters-long';
  const server = createLocalControlHttpServer({
    executor,
    token,
    defaultCwd: root,
    info: {
      protocol: LOCAL_CONTROL_PROTOCOL,
      mode: 'local-user-shell',
      username: 'test-user',
      uid: 501,
      hostname: 'test.local',
      platform: 'darwin',
      shell: TEST_SHELL,
      default_cwd: root,
      concurrency: 1,
      maximum_timeout_seconds: 86_400,
      started_at: new Date().toISOString(),
    },
  });
  servers.push(server);
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, root, token };
}

describe('Local Control HTTP service', () => {
  it('requires its private token, returns run_id immediately, and scopes polling by task', async () => {
    const { baseUrl, root, token } = await setup();
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);

    const denied = await fetch(`${baseUrl}/v1/info`);
    assert.equal(denied.status, 401);

    const taskId = `localtask_${'a'.repeat(32)}`;
    const accepted = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        protocol: LOCAL_CONTROL_PROTOCOL,
        task_id: taskId,
        idempotency_key: 'http-step-1',
        command: "printf 'http-ok'",
        cwd: root,
        timeout_seconds: 10,
        reason: '验证本机 HTTP 提交与轮询通路',
      }),
    });
    assert.equal(accepted.status, 202);
    const initial = (await accepted.json()) as LocalControlRunObservation;
    assert.match(initial.run_id, /^shell_[a-f0-9]{32}$/);
    assert.ok(initial.status === 'queued' || initial.status === 'running');
    assert.equal(accepted.headers.get('location'), `/v1/runs/${initial.run_id}`);

    const hiddenFromAnotherTask = await fetch(
      `${baseUrl}/v1/runs/${initial.run_id}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Urtoris-Local-Task-Id': `localtask_${'b'.repeat(32)}`,
        },
      },
    );
    assert.equal(hiddenFromAnotherTask.status, 404);

    const deadline = Date.now() + 5_000;
    let finished: LocalControlRunObservation | null = null;
    while (Date.now() < deadline) {
      const response = await fetch(`${baseUrl}/v1/runs/${initial.run_id}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Urtoris-Local-Task-Id': taskId,
        },
      });
      assert.equal(response.status, 200);
      const observation =
        (await response.json()) as LocalControlRunObservation;
      if (observation.status !== 'queued' && observation.status !== 'running') {
        finished = observation;
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    assert.equal(finished?.status, 'succeeded');
    assert.equal(finished?.exit_code, 0);
    assert.equal(finished?.stdout, 'http-ok');
  });
});
