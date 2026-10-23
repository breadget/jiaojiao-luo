import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  LOCAL_CONTROL_PROTOCOL,
  type LocalControlInfo,
  type LocalControlRunObservation,
} from '../lib/local-control-protocol';

/**
 * 本机全权限 Shell 的真实门禁。
 *
 * 这些用例打的是**正在运行**的 Control Agent，不是替身：命令以当前 macOS 用户
 * 身份真的跑在 `/bin/zsh` 里。先启动服务：
 *
 *   npm run control:local -- start
 *   node --import tsx scripts/local-control-gate.ts
 */

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = join(projectRoot, 'work/local-control');

async function readRuntimeEnv(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(runtimeDir, 'control.env'), 'utf8');
    const values: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!match) continue;
      values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
    return values;
  } catch {
    return {};
  }
}

const runtimeEnv = await readRuntimeEnv();
const baseUrl = (
  process.env.LOCAL_CONTROL_URL ??
  runtimeEnv.LOCAL_CONTROL_URL ??
  'http://127.0.0.1:3020'
).replace(/\/$/, '');
const token = process.env.LOCAL_CONTROL_TOKEN ?? runtimeEnv.LOCAL_CONTROL_TOKEN ?? '';
if (token.length < 32) {
  throw new Error(
    '缺少 LOCAL_CONTROL_TOKEN：先运行 `npm run control:local -- start`，或把 token 导出到环境里。',
  );
}

const authorization = { Authorization: `Bearer ${token}` };

function taskId(): string {
  return `localtask_${randomUUID().replaceAll('-', '')}`;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(new URL(path, baseUrl), init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body: body as T };
}

async function submit(
  command: string,
  options: { taskId?: string; idempotencyKey?: string; timeoutSeconds?: number } = {},
): Promise<LocalControlRunObservation> {
  const response = await request<LocalControlRunObservation & { error?: string }>(
    '/v1/runs',
    {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol: LOCAL_CONTROL_PROTOCOL,
        task_id: options.taskId ?? taskId(),
        idempotency_key: options.idempotencyKey ?? randomUUID(),
        command,
        cwd: projectRoot,
        timeout_seconds: options.timeoutSeconds ?? 60,
        reason: '本机门禁',
      }),
    },
  );
  if (response.status !== 202) {
    throw new Error(
      `提交被拒（HTTP ${response.status}）：${JSON.stringify(response.body)}`,
    );
  }
  return response.body;
}

async function observe(
  runTaskId: string,
  runId: string,
): Promise<LocalControlRunObservation | null> {
  const response = await request<LocalControlRunObservation>(
    `/v1/runs/${encodeURIComponent(runId)}`,
    { headers: { ...authorization, 'X-Urtoris-Local-Task-Id': runTaskId } },
  );
  if (response.status === 404) return null;
  if (response.status !== 200) {
    throw new Error(`轮询失败（HTTP ${response.status}）`);
  }
  return response.body;
}

const TERMINAL = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);

async function waitForTerminal(
  runTaskId: string,
  runId: string,
  timeoutMs = 30_000,
): Promise<LocalControlRunObservation> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await observe(runTaskId, runId);
    if (current && TERMINAL.has(current.status)) return current;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`运行 ${runId} 没有在 ${timeoutMs} 毫秒内到达终态`);
}

const gates: Array<Record<string, unknown>> = [];

async function gate(
  name: string,
  run: () => Promise<Record<string, unknown>>,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const detail = await run();
    gates.push({ name, ok: true, durationMs: Date.now() - startedAt, ...detail });
  } catch (cause) {
    gates.push({
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const runIds: string[] = [];

let agentInfo: LocalControlInfo | null = null;

await gate('identity-and-auth', async () => {
  const denied = await request('/v1/info');
  assert(denied.status === 401, `未带 token 的 /v1/info 应返回 401，实际 ${denied.status}`);

  const info = await request<LocalControlInfo>('/v1/info', { headers: authorization });
  assert(info.status === 200, `/v1/info 返回 ${info.status}`);
  assert(info.body.protocol === LOCAL_CONTROL_PROTOCOL, '协议版本不匹配');
  assert(info.body.mode === 'local-user-shell', '模式不是 local-user-shell');
  assert(typeof info.body.uid === 'number', '缺少 uid');
  assert(info.body.concurrency === 1, '并发上限不是 1');
  agentInfo = info.body;
  // 证据文件默认不进 Git 之外的个人信息：真实用户名与主机名只在断言里用，
  // 落盘时只保留与 /v1/info 是否一致这个结论。
  return {
    uid: info.body.uid,
    platform: info.body.platform,
    shell: info.body.shell,
    concurrency: info.body.concurrency,
    maximumTimeoutSeconds: info.body.maximum_timeout_seconds,
    agentStartedAt: info.body.started_at,
    unauthenticatedInfoStatus: denied.status,
  };
});

await gate('current-user-shell', async () => {
  // 同一条命令里同时证明：uid、用户名、主机名、shell、工作目录、PATH 里的 CLI。
  const runTaskId = taskId();
  const accepted = await submit(
    "printf 'uid=%s user=%s host=%s shell=%s cwd=%s git=%s\\n' " +
      '"$(id -u)" "$(whoami)" "$(hostname)" "$SHELL" "$PWD" "$(command -v git)"',
    { taskId: runTaskId, idempotencyKey: 'gate-identity' },
  );
  runIds.push(accepted.run_id);
  const finished = await waitForTerminal(runTaskId, accepted.run_id);
  assert(finished.status === 'succeeded', `状态是 ${finished.status}`);
  assert(finished.exit_code === 0, `退出码是 ${finished.exit_code}`);
  assert(agentInfo !== null, '没有拿到 /v1/info');

  const raw = finished.stdout.trim();
  const expected = {
    uid: `uid=${agentInfo.uid}`,
    user: `user=${agentInfo.username}`,
    host: `host=${agentInfo.hostname}`,
    shell: `shell=${agentInfo.shell}`,
    cwd: `cwd=${projectRoot}`,
  };
  for (const [label, fragment] of Object.entries(expected)) {
    assert(raw.includes(fragment), `命令输出里的 ${label} 与 /v1/info 不一致：${raw}`);
  }
  return {
    runId: finished.run_id,
    status: finished.status,
    exitCode: finished.exit_code,
    // 脱敏后仍能看出形状：uid/用户/主机/Shell/目录/CLI 都来自真实登录 shell。
    stdoutRedacted: raw
      .replaceAll(projectRoot, '<project-root>')
      .replaceAll(agentInfo.username, '<user>')
      .replaceAll(agentInfo.hostname, '<host>'),
    matchesAgentIdentity: true,
    stderr: finished.stderr,
    shell: finished.shell,
    cwdIsProjectRoot: finished.cwd === projectRoot,
  };
});

await gate('fast-commands-do-not-stall', async () => {
  // 回归门禁：命令可能在“运行中”快照落盘之前就退出。失去 exit/close 监听时，
  // 运行会永远停在 running 并占住唯一并发位——这里连做 8 次，全部必须迅速定稿。
  const attempts: Array<Record<string, unknown>> = [];
  for (let index = 1; index <= 8; index += 1) {
    const runTaskId = taskId();
    const startedAt = Date.now();
    const accepted = await submit(`printf 'gate-${index}'`, {
      taskId: runTaskId,
      idempotencyKey: `gate-fast-${index}`,
    });
    runIds.push(accepted.run_id);
    const finished = await waitForTerminal(runTaskId, accepted.run_id, 15_000);
    const elapsed = Date.now() - startedAt;
    assert(finished.status === 'succeeded', `第 ${index} 次状态是 ${finished.status}`);
    assert(finished.stdout === `gate-${index}`, `第 ${index} 次输出是 ${finished.stdout}`);
    attempts.push({
      runId: finished.run_id,
      status: finished.status,
      stdout: finished.stdout,
      durationMs: elapsed,
    });
  }
  return {
    repeats: attempts.length,
    maximumDurationMs: Math.max(...attempts.map((item) => item.durationMs as number)),
    attempts,
  };
});

await gate('non-zero-exit-is-reported', async () => {
  const runTaskId = taskId();
  const accepted = await submit("printf 'oops\\n' >&2; exit 7", {
    taskId: runTaskId,
    idempotencyKey: 'gate-nonzero',
  });
  runIds.push(accepted.run_id);
  const finished = await waitForTerminal(runTaskId, accepted.run_id);
  assert(finished.status === 'failed', `状态是 ${finished.status}`);
  assert(finished.exit_code === 7, `退出码是 ${finished.exit_code}`);
  assert(finished.stderr.includes('oops'), 'stderr 没有被捕获');
  assert(
    finished.error?.code === 'COMMAND_EXIT_NONZERO',
    `错误码是 ${finished.error?.code}`,
  );
  return {
    runId: finished.run_id,
    status: finished.status,
    exitCode: finished.exit_code,
    stderr: finished.stderr.trim(),
    errorCode: finished.error?.code,
  };
});

await gate('cancel-kills-the-process-group', async () => {
  const runTaskId = taskId();
  const accepted = await submit("printf 'started\\n'; sleep 600", {
    taskId: runTaskId,
    idempotencyKey: 'gate-cancel',
  });
  runIds.push(accepted.run_id);

  let pid: number | null = null;
  const runningDeadline = Date.now() + 10_000;
  while (Date.now() < runningDeadline && pid === null) {
    const current = await observe(runTaskId, accepted.run_id);
    if (current?.pid) pid = current.pid;
    else await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert(pid !== null, '没有观察到运行中的 pid');

  const cancelled = await request(`/v1/runs/${accepted.run_id}`, {
    method: 'DELETE',
    headers: { ...authorization, 'X-Urtoris-Local-Task-Id': runTaskId },
  });
  assert(
    cancelled.status === 200 || cancelled.status === 202,
    `取消失败（HTTP ${cancelled.status}）`,
  );
  const finished = await waitForTerminal(runTaskId, accepted.run_id);
  assert(finished.status === 'cancelled', `状态是 ${finished.status}`);

  let processGone = false;
  const goneDeadline = Date.now() + 5_000;
  while (Date.now() < goneDeadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    } catch {
      processGone = true;
      break;
    }
  }
  assert(processGone, `进程组 ${pid} 仍然存活`);
  return {
    runId: finished.run_id,
    status: finished.status,
    cancelledPid: pid,
    processGone,
    errorCode: finished.error?.code,
  };
});

await gate('timeout-is-reported', async () => {
  const runTaskId = taskId();
  const accepted = await submit('sleep 600', {
    taskId: runTaskId,
    idempotencyKey: 'gate-timeout',
    timeoutSeconds: 2,
  });
  runIds.push(accepted.run_id);
  const finished = await waitForTerminal(runTaskId, accepted.run_id, 20_000);
  assert(finished.status === 'timed_out', `状态是 ${finished.status}`);
  assert(finished.error?.code === 'TIMEOUT', `错误码是 ${finished.error?.code}`);
  return {
    runId: finished.run_id,
    status: finished.status,
    errorCode: finished.error?.code,
  };
});

await gate('background-process-does-not-pin-the-slot', async () => {
  // 后台进程会继承 stdout 管道，`close` 因此不再到来。运行必须按退出码定稿，
  // 而不是一直占着并发位等到命令超时。
  const runTaskId = taskId();
  const startedAt = Date.now();
  const accepted = await submit("sleep 10 & printf 'detached-ok'", {
    taskId: runTaskId,
    idempotencyKey: 'gate-detached-stdio',
  });
  runIds.push(accepted.run_id);
  const finished = await waitForTerminal(runTaskId, accepted.run_id, 15_000);
  const durationMs = Date.now() - startedAt;
  assert(finished.status === 'succeeded', `状态是 ${finished.status}`);
  assert(finished.stdout === 'detached-ok', `输出是 ${finished.stdout}`);
  assert(durationMs < 8_000, `用了 ${durationMs} 毫秒，说明在等后台进程`);
  return { runId: finished.run_id, status: finished.status, durationMs, stdout: finished.stdout };
});

await gate('idempotency-and-task-isolation', async () => {
  const runTaskId = taskId();
  const first = await submit("printf 'once'", {
    taskId: runTaskId,
    idempotencyKey: 'gate-idempotent',
  });
  runIds.push(first.run_id);
  const repeated = await submit("printf 'once'", {
    taskId: runTaskId,
    idempotencyKey: 'gate-idempotent',
  });
  assert(repeated.run_id === first.run_id, '相同幂等键没有复用运行');

  const conflict = await request('/v1/runs', {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocol: LOCAL_CONTROL_PROTOCOL,
      task_id: runTaskId,
      idempotency_key: 'gate-idempotent',
      command: "printf 'different'",
      cwd: projectRoot,
      timeout_seconds: 60,
    }),
  });
  assert(conflict.status === 409, `冲突应返回 409，实际 ${conflict.status}`);

  const otherTask = await observe(taskId(), first.run_id);
  assert(otherTask === null, '其他任务能读到这次运行');

  await waitForTerminal(runTaskId, first.run_id);
  return {
    runId: first.run_id,
    replayedSameRun: repeated.run_id === first.run_id,
    conflictingCommandStatus: conflict.status,
    crossTaskVisible: otherTask !== null,
  };
});

await gate('audit-is-durable-and-private', async () => {
  const auditPath = join(runtimeDir, 'state', 'audit.jsonl');
  const auditInfo = await stat(auditPath);
  assert(
    (auditInfo.mode & 0o777) === 0o600,
    `audit.jsonl 权限是 ${(auditInfo.mode & 0o777).toString(8)}`,
  );
  const runsInfo = await stat(join(runtimeDir, 'state', 'runs'));
  assert(
    (runsInfo.mode & 0o777) === 0o700,
    `runs 目录权限是 ${(runsInfo.mode & 0o777).toString(8)}`,
  );

  const records = (await readFile(auditPath, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; run_id: string });
  const missing = runIds.filter(
    (runId) => !records.some((record) => record.run_id === runId && record.event === 'finished'),
  );
  assert(missing.length === 0, `这些运行没有 finished 审计行：${missing.join(', ')}`);

  const runFile = await stat(join(runtimeDir, 'state', 'runs', `${runIds[0]}.json`));
  assert(
    (runFile.mode & 0o777) === 0o600,
    `运行文件权限是 ${(runFile.mode & 0o777).toString(8)}`,
  );
  return {
    auditPath: 'work/local-control/state/audit.jsonl',
    auditMode: '0600',
    runsDirectoryMode: '0700',
    runFileMode: '0600',
    runsChecked: runIds.length,
    auditRecords: records.length,
  };
});

const failed = gates.filter((entry) => entry.ok !== true);
const evidence = {
  capturedAt: new Date().toISOString(),
  command: 'node --import tsx scripts/local-control-gate.ts',
  target: baseUrl,
  scope: '当前 macOS 用户（非 root、非沙箱）',
  protocol: LOCAL_CONTROL_PROTOCOL,
  gates,
  summary: {
    total: gates.length,
    passed: gates.length - failed.length,
    failed: failed.length,
  },
};

const evidencePath = join(projectRoot, 'docs/evidence/local-control-review.json');
await mkdir(dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

for (const entry of gates) {
  console.log(
    `${entry.ok === true ? '✔' : '✖'} ${String(entry.name)} (${String(entry.durationMs)}ms)`,
  );
}
console.log(`\n证据：docs/evidence/local-control-review.json`);
console.log(`结论：${evidence.summary.passed}/${evidence.summary.total} 通过`);
if (failed.length > 0) {
  for (const entry of failed) console.error(`失败：${String(entry.name)} — ${String(entry.error)}`);
  process.exitCode = 1;
}
