import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { LOCAL_CONTROL_PROTOCOL } from '@/lib/local-control-protocol';
import { LocalControlExecutor } from '../services/local-control/executor';
import { parseLocalControlSubmission } from '../services/local-control/protocol';
import { LocalControlStorage } from '../services/local-control/storage';

const temporaryRoots: string[] = [];
const executors: LocalControlExecutor[] = [];

/**
 * 生产是 macOS 的 `/bin/zsh`；Linux 的 CI runner 上只有 Bash（清单里连 zsh 都没
 * 列出来），而这两个用例会真的 spawn 一个登录 shell。优先用 zsh 保持与产品一致，
 * 缺失时退回 Bash，这样同一条断言在两边都成立。
 */
const TEST_SHELL = existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash';

afterEach(async () => {
  for (const executor of executors.splice(0)) await executor.shutdown();
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'urtoris-local-control-'));
  temporaryRoots.push(root);
  const storageRoot = join(root, 'state');
  const storage = new LocalControlStorage(storageRoot);
  const executor = new LocalControlExecutor({
    storage,
    shell: TEST_SHELL,
    defaultCwd: root,
    maximumQueuedRuns: 2,
  });
  await executor.init();
  executors.push(executor);
  return { root, storageRoot, executor };
}

function submission(
  root: string,
  overrides: Record<string, unknown> = {},
) {
  return parseLocalControlSubmission(
    {
      protocol: LOCAL_CONTROL_PROTOCOL,
      task_id: `localtask_${'1'.repeat(32)}`,
      idempotency_key: 'step-1',
      command: "printf 'ready'",
      cwd: root,
      timeout_seconds: 10,
      reason: '验证本机命令通道',
      ...overrides,
    },
    root,
  );
}

async function waitForTerminal(
  executor: LocalControlExecutor,
  taskId: string,
  runId: string,
  timeoutMs = 7_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = executor.getRun(taskId, runId);
    if (run && !['queued', 'running'].includes(run.status)) return run;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`run ${runId} did not finish`);
}

/** Storage that makes every durable write slow, to widen the spawn/exit window. */
class SlowStorage extends LocalControlStorage {
  constructor(
    root: string,
    private readonly delayMs: number,
  ) {
    super(root);
  }

  override async saveRun(
    run: Parameters<LocalControlStorage['saveRun']>[0],
  ): Promise<void> {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, this.delayMs));
    return super.saveRun(run);
  }

  override async appendAudit(
    event: Parameters<LocalControlStorage['appendAudit']>[0],
    run: Parameters<LocalControlStorage['appendAudit']>[1],
  ): Promise<void> {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, this.delayMs));
    return super.appendAudit(event, run);
  }
}

describe('Local Control Executor', () => {
  it('提交立即得到 run_id，随后捕获当前用户 shell 的终态和审计', async () => {
    const { root, storageRoot, executor } = await setup();
    const request = submission(root);
    const accepted = await executor.submit(request);
    assert.match(accepted.run_id, /^shell_[a-f0-9]{32}$/);
    assert.ok(['queued', 'running'].includes(accepted.status));

    const finished = await waitForTerminal(
      executor,
      request.task_id,
      accepted.run_id,
    );
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.exit_code, 0);
    assert.equal(finished.stdout, 'ready');
    assert.equal(finished.cwd, root);
    assert.equal(finished.shell, TEST_SHELL);
    assert.equal(finished.timeout_seconds, 10);

    const auditPath = join(storageRoot, 'audit.jsonl');
    const audit = await readFile(auditPath, 'utf8');
    assert.match(audit, /"event":"submitted"/);
    assert.match(audit, /"event":"finished"/);
    assert.match(audit, /printf 'ready'/);
    assert.equal((await stat(auditPath)).mode & 0o777, 0o600);
  });

  it('命令比落盘更快时不会丢掉终态', async () => {
    // `error` / `exit` / `close` 是一次性事件：如果在挂监听器之前先等一次
    // 落盘，一条跑得比写盘还快的命令（`printf ready` 约 10 毫秒，而负载下两
    // 次写盘更久）会退出到空监听列表里，运行永远停在 running 并占住并发位。
    const root = await mkdtemp(join(tmpdir(), 'urtoris-local-control-'));
    temporaryRoots.push(root);
    const storage = new SlowStorage(join(root, 'state'), 150);
    const executor = new LocalControlExecutor({
      storage,
      shell: TEST_SHELL,
      defaultCwd: root,
      maximumQueuedRuns: 2,
    });
    await executor.init();
    executors.push(executor);

    const request = submission(root);
    const accepted = await executor.submit(request);
    const finished = await waitForTerminal(
      executor,
      request.task_id,
      accepted.run_id,
      30_000,
    );
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.stdout, 'ready');

    // 与内存态一致：磁盘上的运行文件定稿为终态，而不是被更早的 running 快照覆盖。
    const persisted = JSON.parse(
      await readFile(join(root, 'state', 'runs', `${accepted.run_id}.json`), 'utf8'),
    ) as { status: string };
    assert.equal(persisted.status, 'succeeded');
    const events = (await readFile(join(root, 'state', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { event: string }).event);
    assert.deepEqual(events, ['submitted', 'started', 'finished']);
  });

  it('后台进程占着输出管道时按退出码定稿，不吊住并发位', async () => {
    const { root, executor } = await setup();
    const request = submission(root, {
      // 比 2 秒宽限略长即可：既证明不会等到 5 秒，又不让孤儿进程拖住测试进程。
      command: "sleep 5 & printf 'done'",
      idempotency_key: 'stdio-grace',
    });
    const accepted = await executor.submit(request);
    const finished = await waitForTerminal(
      executor,
      request.task_id,
      accepted.run_id,
      10_000,
    );
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.exit_code, 0);
    assert.equal(finished.stdout, 'done');
  });

  it('相同幂等请求复用运行，不同命令冲突', async () => {
    const { root, executor } = await setup();
    const request = submission(root);
    const first = await executor.submit(request);
    const repeated = await executor.submit(request);
    assert.equal(repeated.run_id, first.run_id);

    await assert.rejects(
      executor.submit(
        submission(root, {
          command: "printf 'different'",
        }),
      ),
      (cause: unknown) =>
        cause instanceof Error && cause.message.includes('idempotency key'),
    );
  });

  it('可以取消运行中的整个 shell 进程组', async () => {
    const { root, executor } = await setup();
    const request = submission(root, {
      command: "printf 'started\\n'; sleep 30",
      idempotency_key: 'cancel-me',
    });
    const accepted = await executor.submit(request);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (executor.getRun(request.task_id, accepted.run_id)?.status === 'running') {
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    const cancelling = await executor.cancelRun(
      request.task_id,
      accepted.run_id,
    );
    assert.equal(cancelling?.cancellation_requested, true);
    const finished = await waitForTerminal(
      executor,
      request.task_id,
      accepted.run_id,
    );
    assert.equal(finished.status, 'cancelled');
    assert.equal(finished.error?.code, 'CANCELLED');
  });

  it('超时后如实标记 timed_out', async () => {
    const { root, executor } = await setup();
    const request = submission(root, {
      command: 'sleep 30',
      idempotency_key: 'time-me-out',
      timeout_seconds: 1,
    });
    const accepted = await executor.submit(request);
    const finished = await waitForTerminal(
      executor,
      request.task_id,
      accepted.run_id,
    );
    assert.equal(finished.status, 'timed_out');
    assert.equal(finished.error?.code, 'TIMEOUT');
  });
});

describe('Local Control protocol', () => {
  it('允许任意 shell 语法，但拒绝相对 cwd、坏 task id 与超长超时', () => {
    const root = '/tmp';
    assert.equal(
      submission(root, { command: "printf x | tr x y > /tmp/example" }).command,
      "printf x | tr x y > /tmp/example",
    );
    assert.throws(() => submission(root, { cwd: 'relative' }), /absolute path/);
    assert.throws(() => submission(root, { task_id: 'bad' }), /task_id/);
    assert.throws(
      () => submission(root, { timeout_seconds: 86_401 }),
      /timeout_seconds/,
    );
  });
});
