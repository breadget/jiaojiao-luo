import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { LOCAL_CONTROL_PROTOCOL } from '@/lib/local-control-protocol';
import { LocalControlExecutor } from '../services/local-control/executor';
import { createLocalControlHttpServer } from '../services/local-control/server';
import { LocalControlStorage } from '../services/local-control/storage';
import {
  LocalControlStore,
  LocalStoreError,
  type LocalStoreStatus,
} from '../services/local-control/store';

/**
 * 本机记录与项目的存放处：位置由用户自己选，写在选中的文件夹里。
 */

const TEST_SHELL = existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash';
const TOKEN = 'store-test-token-that-is-at-least-32-characters';

const roots: string[] = [];
const servers: Server[] = [];
const executors: LocalControlExecutor[] = [];

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

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe('本机存储', () => {
  it('没选位置之前不落盘，选了之后写在用户选的文件夹里', async () => {
    const work = await temporary('urtoris-store-');
    const chosen = join(work, '我的记录');
    const store = new LocalControlStore(join(work, 'store.json'));
    await store.init();

    const before = await store.status();
    assert.equal(before.root, null);
    await assert.rejects(
      () => store.write('projects', 'demo', { name: '示例' }),
      (cause: unknown) =>
        cause instanceof LocalStoreError && cause.code === 'STORE_NOT_CONFIGURED',
    );

    const after = await store.setRoot(chosen);
    assert.equal(after.root, chosen);
    assert.equal(after.folder, join(chosen, 'urtoris'));

    const saved = await store.write('projects', 'demo', {
      name: '示例项目',
      workflowIds: ['w1'],
    });
    assert.equal(saved.id, 'demo');
    assert.deepEqual(await store.read('projects', 'demo'), {
      name: '示例项目',
      workflowIds: ['w1'],
    });

    // 内容确实写进了用户选的目录，权限是 0600。
    const file = join(chosen, 'urtoris', 'projects', 'demo.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.match(await readFile(file, 'utf8'), /示例项目/);
    assert.equal((await stat(join(work, 'store.json'))).mode & 0o777, 0o600);

    const listed = await store.list('projects');
    assert.deepEqual(
      listed.map((item) => item.id),
      ['demo'],
    );
    await store.remove('projects', 'demo');
    assert.deepEqual(await store.list('projects'), []);
  });

  it('位置记在配置里：新建实例后仍然是同一个文件夹', async () => {
    const work = await temporary('urtoris-store-');
    const chosen = join(work, 'records');
    const config = join(work, 'store.json');
    const first = new LocalControlStore(config);
    await first.init();
    await first.setRoot(chosen);
    await first.write('conversations', 'c1', { title: '第一次对话' });

    const second = new LocalControlStore(config);
    await second.init();
    const status: LocalStoreStatus = await second.status();
    assert.equal(status.root, chosen);
    assert.equal(status.collections.conversations, 1);
    assert.deepEqual(await second.read('conversations', 'c1'), {
      title: '第一次对话',
    });
  });

  it('拒绝相对路径、根目录、越界编号和不认识的类型', async () => {
    const work = await temporary('urtoris-store-');
    const store = new LocalControlStore(join(work, 'store.json'));
    await store.init();

    await assert.rejects(() => store.setRoot('relative/dir'), /绝对路径/);
    await assert.rejects(() => store.setRoot('/'), /磁盘根目录/);

    await store.setRoot(join(work, 'records'));
    const cases: Array<() => Promise<unknown>> = [
      () => store.write('projects', '../escape', { a: 1 }),
      () => store.write('projects', 'a/b', { a: 1 }),
      () => store.write('projects', '', { a: 1 }),
      () => store.write('secrets', 'x', { a: 1 }),
      () => store.write('projects', 'x'.repeat(81), { a: 1 }),
    ];
    for (const run of cases) {
      await assert.rejects(
        run,
        (cause: unknown) =>
          cause instanceof LocalStoreError && cause.code === 'INVALID_REQUEST',
      );
    }
    assert.equal(existsSync(join(work, 'escape.json')), false);
    assert.equal(existsSync(join(work, 'records', 'urtoris', 'secrets')), false);
  });

  it('单条记录超过 256 KB 直接拒绝', async () => {
    const work = await temporary('urtoris-store-');
    const store = new LocalControlStore(join(work, 'store.json'));
    await store.init();
    await store.setRoot(join(work, 'records'));
    await assert.rejects(
      () => store.write('runs', 'big', { blob: 'x'.repeat(300 * 1024) }),
      /256 KB/,
    );
  });
});

describe('本机存储的 HTTP 接口', () => {
  async function serve(store?: LocalControlStore) {
    const work = await temporary('urtoris-store-http-');
    const executor = new LocalControlExecutor({
      storage: new LocalControlStorage(join(work, 'state')),
      shell: TEST_SHELL,
      defaultCwd: work,
      maximumQueuedRuns: 2,
    });
    await executor.init();
    executors.push(executor);
    const server = createLocalControlHttpServer({
      executor,
      token: TOKEN,
      defaultCwd: work,
      info: {
        protocol: LOCAL_CONTROL_PROTOCOL,
        mode: 'local-user-shell',
        username: 'test-user',
        uid: 501,
        hostname: 'test.local',
        platform: 'darwin',
        shell: TEST_SHELL,
        default_cwd: work,
        concurrency: 1,
        maximum_timeout_seconds: 86_400,
        started_at: new Date().toISOString(),
      },
      ...(store ? { store } : {}),
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
    return { baseUrl: `http://127.0.0.1:${port}`, work };
  }

  it('要 token；可以选位置、读写并列出记录', async () => {
    const work = await temporary('urtoris-store-http-');
    const chosen = join(work, '我的位置');
    const store = new LocalControlStore(join(work, 'store.json'));
    await store.init();
    const { baseUrl } = await serve(store);
    const auth = { Authorization: `Bearer ${TOKEN}` };

    const denied = await fetch(`${baseUrl}/v1/store`);
    assert.equal(denied.status, 401);

    const empty = await fetch(`${baseUrl}/v1/store`, { headers: auth });
    assert.equal(empty.status, 200);
    assert.equal(((await empty.json()) as LocalStoreStatus).root, null);

    const picked = await fetch(`${baseUrl}/v1/store/root`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: chosen }),
    });
    assert.equal(picked.status, 200);
    assert.equal(((await picked.json()) as LocalStoreStatus).root, chosen);

    const saved = await fetch(`${baseUrl}/v1/store/projects/p1`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { name: '第一个项目' } }),
    });
    assert.equal(saved.status, 200);

    const read = await fetch(`${baseUrl}/v1/store/projects/p1`, { headers: auth });
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json()) as unknown, {
      id: 'p1',
      value: { name: '第一个项目' },
    });

    const list = await fetch(`${baseUrl}/v1/store/projects`, { headers: auth });
    assert.equal(list.status, 200);
    assert.deepEqual(
      ((await list.json()) as { items: Array<{ id: string }> }).items.map(
        (item) => item.id,
      ),
      ['p1'],
    );

    const missing = await fetch(`${baseUrl}/v1/store/projects/nope`, {
      headers: auth,
    });
    assert.equal(missing.status, 404);

    const removed = await fetch(`${baseUrl}/v1/store/projects/p1`, {
      method: 'DELETE',
      headers: auth,
    });
    assert.equal(removed.status, 200);

    // 有存储但还没选位置时写记录应给 409，而不是静默丢数据。
    const bareWork = await temporary('urtoris-store-http-bare-');
    const bareStore = new LocalControlStore(join(bareWork, 'store.json'));
    await bareStore.init();
    const bare = await serve(bareStore);
    const refused = await fetch(`${bare.baseUrl}/v1/store/runs/r1`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { ok: true } }),
    });
    assert.equal(refused.status, 409);
  });
});
