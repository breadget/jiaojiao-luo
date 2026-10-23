import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { installDatabaseMock } from './helpers/api';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import {
  EVENT_PAGE_LIMIT,
  type NodeBinding,
  type TelemetryEvent,
  listTelemetryEvents,
  projectNodeTelemetry,
  resolveInternalNodeId,
  sanitizeTelemetryPayload,
  toRuntimeSnapshot,
  unmappedExternalNodes,
} from '@/lib/server/node-telemetry';

const database: TestDatabase = createTestDatabase();
installDatabaseMock(database.d1);

type StoreModule = typeof import('@/lib/server/workflow-store');
let store!: StoreModule;

let eventCounter = 0;

// 整个文件只关一次库：多个 describe 各关一次会让后面的套件拿到已关闭的连接。
after(() => database.close());

async function insertEvent(input: {
  requestId?: string | null;
  sessionId?: string | null;
  executionId?: string | null;
  workflow?: string | null;
  eventType: string;
  node?: string | null;
  message?: string;
  payload?: unknown;
  durationMs?: number | null;
  createdAt?: number;
  level?: 'debug' | 'info' | 'warn' | 'error';
}): Promise<number> {
  eventCounter += 1;
  const id = `evt_${eventCounter}`;
  const result = await database.d1
    .prepare(
      `INSERT INTO n8n_events (
         id, request_id, session_id, workflow, execution_id, level, event_type,
         node, message, payload_json, duration_ms, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.requestId ?? null,
      input.sessionId ?? null,
      input.workflow ?? 'urtoris-test',
      input.executionId ?? null,
      input.level ?? 'info',
      input.eventType,
      input.node ?? null,
      input.message ?? '',
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.durationMs ?? null,
      input.createdAt ?? Date.now() + eventCounter,
    )
    .run();
  return Number(result.meta.last_row_id);
}

async function insertRun(input: {
  id: string;
  requestId: string | null;
  workflowId: string;
  workflowName: string;
  status: 'running' | 'failed' | 'completed';
  startedAt: number;
  executionId?: string | null;
  sessionId?: string | null;
}) {
  // runs.workflow_id 有外键，先把工作流行补上
  await database.d1
    .prepare(
      `INSERT OR IGNORE INTO workflows (
         id, name, description, draft_steps_json, version,
         has_unpublished_changes, created_at, updated_at
       ) VALUES (?, ?, '', '[]', 1, 0, ?, ?)`,
    )
    .bind(input.workflowId, input.workflowName, input.startedAt, input.startedAt)
    .run();
  await database.d1
    .prepare(
      `INSERT INTO runs (
         id, workflow_id, workflow_name, workflow_version, status, steps_json,
         logs_json, output_json, started_at, finished_at, request_id, session_id,
         engine, execution_id, mode, degraded
       ) VALUES (?, ?, ?, ?, ?, '[]', '[]', '{}', ?, ?, ?, ?, 'n8n', ?, 'rules', 0)`,
    )
    .bind(
      input.id,
      input.workflowId,
      input.workflowName,
      1,
      input.status,
      input.startedAt,
      input.status === 'running' ? null : input.startedAt + 500,
      input.requestId,
      input.sessionId ?? null,
      input.executionId ?? null,
    )
    .run();
}
async function bindExecution(input: {
  executionId: string;
  requestId: string;
  workflowId: string;
  workflowName: string;
}) {
  await database.d1
    .prepare(
      `INSERT INTO n8n_execution_map (
         execution_id, request_id, workflow_id, workflow_name, session_id, created_at
       ) VALUES (?, ?, ?, ?, NULL, ?)`,
    )
    .bind(
      input.executionId,
      input.requestId,
      input.workflowId,
      input.workflowName,
      Date.now(),
    )
    .run();
}

const BINDINGS: NodeBinding[] = [
  {
    internalNodeId: 'node_trigger',
    externalNodeId: 'b1000000-0000-4000-8000-000000000001',
    externalNodeName: 'U::node_trigger::primary',
    role: 'primary',
  },
  {
    internalNodeId: 'node_agent',
    externalNodeId: 'b1000000-0000-4000-8000-000000000002',
    externalNodeName: 'U::node_agent::primary',
    role: 'primary',
  },
  {
    internalNodeId: 'node_out',
    externalNodeId: 'b1000000-0000-4000-8000-000000000003',
    externalNodeName: 'U::node_out::primary',
    role: 'primary',
  },
];

function eventsOf(
  rows: { seq: number; eventType: string; node: string; createdAt: number; durationMs?: number }[],
): TelemetryEvent[] {
  return rows.map((row) => ({
    seq: row.seq,
    requestId: 'req',
    sessionId: null,
    executionId: null,
    workflow: 'urtoris-test',
    eventType: row.eventType,
    level: 'info' as const,
    externalNode: row.node,
    internalNodeId: resolveInternalNodeId(BINDINGS, row.node),
    message: '',
    payload: null,
    payloadTruncated: false,
    durationMs: row.durationMs ?? null,
    createdAt: row.createdAt,
  }));
}

describe('节点遥测：映射与状态折叠', () => {
  before(async () => {
    store = await import('@/lib/server/workflow-store');
  });

  it('按 external_node_id 与 external_node_name 双向解析内部 nodeId', () => {
    assert.equal(
      resolveInternalNodeId(BINDINGS, 'b1000000-0000-4000-8000-000000000002'),
      'node_agent',
    );
    assert.equal(
      resolveInternalNodeId(BINDINGS, 'U::node_agent::primary'),
      'node_agent',
    );
    assert.equal(resolveInternalNodeId(BINDINGS, 'unknown-node'), null);
    assert.equal(resolveInternalNodeId(BINDINGS, null), null);
    assert.equal(resolveInternalNodeId(BINDINGS, '   '), null);
  });

  it('没有事件时所有节点都是 waiting（服务端真实状态，不是前端猜的）', () => {
    const states = projectNodeTelemetry({
      nodeIds: ['node_trigger', 'node_agent', 'node_out'],
      bindings: BINDINGS,
      events: [],
    });
    assert.deepEqual(
      [...states.values()].map((node) => node.state),
      ['waiting', 'waiting', 'waiting'],
    );
    assert.equal(toRuntimeSnapshot(states.get('node_agent')!).state, 'waiting');
  });

  it('waiting → running → success，并算出真实耗时', () => {
    const states = projectNodeTelemetry({
      nodeIds: ['node_agent'],
      bindings: BINDINGS,
      events: eventsOf([
        { seq: 1, eventType: 'node.started', node: BINDINGS[1].externalNodeId, createdAt: 1000 },
        { seq: 2, eventType: 'node.finished', node: BINDINGS[1].externalNodeId, createdAt: 1420 },
      ]),
    });
    const agent = states.get('node_agent')!;
    assert.equal(agent.state, 'success');
    assert.equal(agent.startedAt, 1000);
    assert.equal(agent.finishedAt, 1420);
    assert.equal(agent.durationMs, 420);
  });

  it('节点失败 → error，并保留显式 durationMs', () => {
    const states = projectNodeTelemetry({
      nodeIds: ['node_agent'],
      bindings: BINDINGS,
      events: eventsOf([
        { seq: 1, eventType: 'node.started', node: 'U::node_agent::primary', createdAt: 1000 },
        {
          seq: 2,
          eventType: 'node.error',
          node: 'U::node_agent::primary',
          createdAt: 1500,
          durationMs: 480,
        },
      ]),
    });
    const agent = states.get('node_agent')!;
    assert.equal(agent.state, 'error');
    assert.equal(agent.durationMs, 480, '显式耗时优先于时间差');
  });

  it('乱序：终态之后到达的 running 不会把状态打回去', () => {
    const states = projectNodeTelemetry({
      nodeIds: ['node_agent'],
      bindings: BINDINGS,
      events: eventsOf([
        { seq: 1, eventType: 'node.started', node: 'U::node_agent::primary', createdAt: 1000 },
        { seq: 2, eventType: 'node.finished', node: 'U::node_agent::primary', createdAt: 1200 },
        { seq: 3, eventType: 'node.running', node: 'U::node_agent::primary', createdAt: 1300 },
      ]),
    });
    const agent = states.get('node_agent')!;
    assert.equal(agent.state, 'success');
    assert.equal(agent.conflicts, 1, '冲突要被记账，不能静默');
  });

  it('乱序：数组顺序打乱也能得到同一结果（按 seq 折叠）', () => {
    const raw = [
      { seq: 2, eventType: 'node.finished', node: 'U::node_agent::primary', createdAt: 1200 },
      { seq: 1, eventType: 'node.started', node: 'U::node_agent::primary', createdAt: 1000 },
    ];
    const states = projectNodeTelemetry({
      nodeIds: ['node_agent'],
      bindings: BINDINGS,
      events: eventsOf(raw),
    });
    assert.equal(states.get('node_agent')!.state, 'success');
    assert.equal(states.get('node_agent')!.durationMs, 200);
  });

  it('同一个 n8n 节点绑定到多个内部节点时，状态同时写到两边', () => {
    const shared: NodeBinding[] = [
      { internalNodeId: 'a', externalNodeId: 'ext-1', externalNodeName: 'U::a', role: 'primary' },
      { internalNodeId: 'b', externalNodeId: 'ext-1', externalNodeName: 'U::a', role: 'alias' },
    ];
    const states = projectNodeTelemetry({
      nodeIds: ['a', 'b'],
      bindings: shared,
      events: eventsOf([
        { seq: 1, eventType: 'node.started', node: 'ext-1', createdAt: 10 },
        { seq: 2, eventType: 'node.finished', node: 'ext-1', createdAt: 30 },
      ]),
    });
    assert.equal(states.get('a')!.state, 'success');
    assert.equal(states.get('b')!.state, 'success');
  });

  it('映射缺失时状态保持 waiting，并且被显式列出来', () => {
    const events = eventsOf([
      { seq: 1, eventType: 'node.started', node: 'n8n-node-not-in-bindings', createdAt: 5 },
      { seq: 2, eventType: 'node.finished', node: 'n8n-node-not-in-bindings', createdAt: 9 },
    ]);
    assert.equal(events[0].internalNodeId, null);
    const states = projectNodeTelemetry({
      nodeIds: ['node_agent'],
      bindings: BINDINGS,
      events,
    });
    assert.equal(states.get('node_agent')!.state, 'waiting');
    assert.deepEqual(unmappedExternalNodes(BINDINGS, events), [
      'n8n-node-not-in-bindings',
    ]);
  });

  it('不认识的事件类型不改变状态', () => {
    const states = projectNodeTelemetry({
      nodeIds: ['node_agent'],
      bindings: BINDINGS,
      events: eventsOf([
        { seq: 1, eventType: 'workflow.started', node: 'U::node_agent::primary', createdAt: 1 },
      ]),
    });
    assert.equal(states.get('node_agent')!.state, 'waiting');
  });
});

describe('失败原因：从事件一路带到画布', () => {
  async function foldError(row: Parameters<typeof insertEvent>[0]) {
    const requestId = row.requestId!;
    await insertEvent(row);
    const events = await listTelemetryEvents(database.d1, {
      requestId,
      bindings: BINDINGS,
    });
    const telemetry = projectNodeTelemetry({
      nodeIds: ['node_trigger', 'node_agent', 'node_out'],
      bindings: BINDINGS,
      events,
    });
    return telemetry.get('node_agent')!;
  }

  it('workflow.error 让失败节点变成 error，并带出 code / message / detail', async () => {
    const agent = await foldError({
      requestId: 'req_error_workflow',
      eventType: 'workflow.error',
      node: 'U::node_agent::primary',
      message: '[NODE_ERROR] 聚类节点炸了',
      payload: {
        code: 'NODE_ERROR',
        message: "Cannot read properties of undefined (reading 'indexOf')",
        detail: 'TypeError: …\n    at tokenize (evalmachine:20:21)',
      },
    });
    assert.equal(agent.state, 'error');
    assert.equal(agent.error?.code, 'NODE_ERROR');
    assert.equal(
      agent.error?.message,
      "Cannot read properties of undefined (reading 'indexOf')",
    );
    assert.equal(agent.error?.eventType, 'workflow.error');
    assert.ok(agent.error?.detail?.includes('tokenize'));

    const snapshot = toRuntimeSnapshot(agent);
    assert.equal(snapshot.error, agent.error?.message);
    assert.equal(snapshot.errorCode, 'NODE_ERROR');
  });

  it('run.failed 也认，并且能兜住嵌套的 error 对象', async () => {
    const agent = await foldError({
      requestId: 'req_error_run_failed',
      eventType: 'run.failed',
      node: 'U::node_agent::primary',
      payload: {
        error: { code: 'LLM_TIMEOUT', message: '模型调用超时', detail: 'timeout 30000ms' },
      },
    });
    assert.equal(agent.state, 'error');
    assert.equal(agent.error?.code, 'LLM_TIMEOUT');
    assert.equal(agent.error?.message, '模型调用超时');
    assert.equal(agent.error?.detail, 'timeout 30000ms');
  });

  it('没有结构化字段时退回事件 message，绝不编原因', async () => {
    const agent = await foldError({
      requestId: 'req_error_plain',
      eventType: 'node.error',
      node: 'U::node_agent::primary',
      message: '连接被拒绝',
    });
    assert.equal(agent.state, 'error');
    assert.equal(agent.error?.code, null);
    assert.equal(agent.error?.message, '连接被拒绝');
    assert.equal(agent.error?.detail, null);
  });

  it('先到的原因不会被后来的重复上报换掉', async () => {
    const requestId = 'req_error_first_wins';
    await insertEvent({
      requestId,
      eventType: 'workflow.error',
      node: 'U::node_agent::primary',
      payload: { code: 'NODE_ERROR', message: '第一个原因' },
    });
    await insertEvent({
      requestId,
      eventType: 'run.failed',
      node: 'U::node_agent::primary',
      payload: { code: 'INTERNAL_ERROR', message: '第二个原因' },
    });
    const events = await listTelemetryEvents(database.d1, {
      requestId,
      bindings: BINDINGS,
    });
    const telemetry = projectNodeTelemetry({
      nodeIds: ['node_agent'],
      bindings: BINDINGS,
      events,
    });
    const agent = telemetry.get('node_agent')!;
    assert.equal(agent.error?.message, '第一个原因');
    assert.equal(agent.error?.code, 'NODE_ERROR');
    assert.equal(
      agent.conflicts,
      0,
      '同一个终态的重复上报不算状态冲突，但原因仍然以先到的为准',
    );
  });

  it('没失败过的节点 error 就是 null，不造字段', async () => {
    const requestId = 'req_error_none';
    await insertEvent({
      requestId,
      eventType: 'node.finished',
      node: 'U::node_agent::primary',
    });
    const events = await listTelemetryEvents(database.d1, {
      requestId,
      bindings: BINDINGS,
    });
    const telemetry = projectNodeTelemetry({
      nodeIds: ['node_agent'],
      bindings: BINDINGS,
      events,
    });
    const agent = telemetry.get('node_agent')!;
    assert.equal(agent.state, 'success');
    assert.equal(agent.error, null);
    assert.deepEqual(toRuntimeSnapshot(agent), { state: 'success' });
  });
});

describe('遥测脱敏与限制', () => {
  it('凭据字段被替换成 [redacted]', () => {
    const { payload } = sanitizeTelemetryPayload({
      headers: { authorization: 'Bearer abcdefghijklmnop1234' },
      apiKey: 'sk-abcdefghijklmnopqrstuvwx',
      ok: true,
    });
    const text = JSON.stringify(payload);
    assert.ok(!text.includes('Bearer abcdefghijklmnop1234'));
    assert.ok(!text.includes('sk-abcdefghijklmnopqrstuvwx'));
    assert.ok(text.includes('[redacted]'));
    assert.ok(text.includes('"ok":true'));
  });

  it('超长字符串被截断并标记 truncated', () => {
    const { payload, truncated } = sanitizeTelemetryPayload({ output: 'x'.repeat(5000) });
    assert.equal(truncated, true);
    assert.ok(JSON.stringify(payload).length < 2000);
  });

  it('超大 payload 折叠成有界 preview（转义后也不能超限）', () => {
    const big = Object.fromEntries(
      Array.from({ length: 400 }, (_, index) => [`k${index}`, 'y"'.repeat(50)]),
    );
    const { payload, truncated } = sanitizeTelemetryPayload(big);
    assert.equal(truncated, true);
    assert.ok(
      JSON.stringify(payload).length <= 8_200,
      `折叠后的 payload 仍然超限：${JSON.stringify(payload).length}`,
    );
  });

  it('循环引用不会炸', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const { payload } = sanitizeTelemetryPayload(cyclic);
    assert.ok(payload);
  });

  it('嵌套深度超限时收敛', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index < 12; index += 1) deep = { next: deep };
    const { truncated } = sanitizeTelemetryPayload(deep);
    assert.equal(truncated, true);
  });
});

describe('事件流：游标、隔离与重连', () => {

  it('按 rowid 游标增量拉取，不重复也不丢（模拟 SSE 断线重连）', async () => {
    const requestId = 'req_cursor';
    for (let index = 0; index < 5; index += 1) {
      await insertEvent({
        requestId,
        eventType: 'node.started',
        node: BINDINGS[1].externalNodeId,
        message: `第 ${index} 条`,
      });
    }
    const first = await listTelemetryEvents(database.d1, { requestId, limit: 3 });
    assert.equal(first.length, 3);
    assert.deepEqual(
      first.map((event) => event.seq),
      first.map((event) => event.seq).sort((a, b) => a - b),
      '必须按 seq 升序',
    );

    // 断线：从最后一条的 seq 继续
    const cursor = first.at(-1)!.seq;
    await insertEvent({
      requestId,
      eventType: 'node.finished',
      node: BINDINGS[1].externalNodeId,
    });
    const second = await listTelemetryEvents(database.d1, { requestId, afterSeq: cursor });
    assert.equal(second.length, 3, '断线后只补齐没拿到的（5-3 剩余 + 新增 1）');
    assert.ok(second.every((event) => event.seq > cursor));
    assert.equal(second.at(-1)!.eventType, 'node.finished');

    // 完全重放一次也不会重复
    const all = await listTelemetryEvents(database.d1, { requestId });
    assert.equal(all.length, 6);
    assert.equal(new Set(all.map((event) => event.seq)).size, 6);
  });

  it('分页上限被强制在 100 以内', async () => {
    const requestId = 'req_paging';
    for (let index = 0; index < 5; index += 1) {
      await insertEvent({ requestId, eventType: 'node.started', node: 'x' });
    }
    const page = await listTelemetryEvents(database.d1, { requestId, limit: 10_000 });
    assert.ok(page.length <= EVENT_PAGE_LIMIT);
    assert.equal(page.length, 5);
  });

  it('两个 workflow 并发：事件不会串号', async () => {
    await insertEvent({
      requestId: 'req_a',
      workflow: 'wf_a',
      eventType: 'node.finished',
      node: BINDINGS[1].externalNodeId,
    });
    await insertEvent({
      requestId: 'req_b',
      workflow: 'wf_b',
      eventType: 'node.error',
      node: BINDINGS[1].externalNodeId,
    });
    const a = await listTelemetryEvents(database.d1, { requestId: 'req_a' });
    const b = await listTelemetryEvents(database.d1, { requestId: 'req_b' });
    assert.equal(a.length, 1);
    assert.equal(a[0].workflow, 'wf_a');
    assert.equal(a[0].eventType, 'node.finished');
    assert.equal(b.length, 1);
    assert.equal(b[0].workflow, 'wf_b');
    assert.equal(b[0].eventType, 'node.error');
  });

  it('同一 workflow 两个 requestId 并发：各自只看到自己的节点状态', async () => {
    const base = Date.now() + 10_000;
    await insertEvent({
      requestId: 'req_x',
      workflow: 'wf_same',
      eventType: 'node.started',
      node: BINDINGS[1].externalNodeId,
      createdAt: base,
    });
    await insertEvent({
      requestId: 'req_x',
      workflow: 'wf_same',
      eventType: 'node.finished',
      node: BINDINGS[1].externalNodeId,
      createdAt: base + 100,
    });
    await insertEvent({
      requestId: 'req_y',
      workflow: 'wf_same',
      eventType: 'node.started',
      node: BINDINGS[1].externalNodeId,
      createdAt: base,
    });
    await insertEvent({
      requestId: 'req_y',
      workflow: 'wf_same',
      eventType: 'node.error',
      node: BINDINGS[1].externalNodeId,
      createdAt: base + 200,
    });

    const x = await listTelemetryEvents(database.d1, { requestId: 'req_x' });
    const y = await listTelemetryEvents(database.d1, { requestId: 'req_y' });
    const statesX = projectNodeTelemetry({
      nodeIds: ['node_agent'],
      bindings: BINDINGS,
      events: x,
    });
    const statesY = projectNodeTelemetry({
      nodeIds: ['node_agent'],
      bindings: BINDINGS,
      events: y,
    });
    assert.equal(statesX.get('node_agent')!.state, 'success');
    assert.equal(statesY.get('node_agent')!.state, 'error');
  });

  it('未知 requestId 返回空页而不是报错', async () => {
    const events = await listTelemetryEvents(database.d1, { requestId: 'req_nope' });
    assert.deepEqual(events, []);
  });
});

describe('executionId 精确绑定优先于时间窗 fallback', () => {

  it('有精确绑定：直接按 executionId 回填 requestId，不做时间窗猜测', async () => {
    const workflowName = 'urtoris-wf-bound';
    await insertRun({
      id: 'run_bound',
      requestId: 'req_bound',
      workflowId: 'wf_bound',
      workflowName,
      status: 'running',
      startedAt: Date.now(),
    });
    await bindExecution({
      executionId: 'exec-bound-1',
      requestId: 'req_bound',
      workflowId: 'wf_bound',
      workflowName,
    });

    const executionId = await store.linkRunToErrorEvent({
      runId: 'run_bound',
      workflowName,
      startedAt: Date.now(),
      requestId: 'req_bound',
    });
    assert.equal(executionId, 'exec-bound-1');

    const row = await database.d1
      .prepare(`SELECT execution_id FROM runs WHERE id = 'run_bound'`)
      .first<{ execution_id: string }>();
    assert.equal(row?.execution_id, 'exec-bound-1');
  });

  it('旧工作流没有映射时才退回 ±2 分钟时间窗', async () => {
    const workflowName = 'urtoris-wf-legacy';
    const startedAt = Date.now();
    await insertRun({
      id: 'run_legacy',
      requestId: 'req_legacy',
      workflowId: 'wf_legacy',
      workflowName,
      status: 'running',
      startedAt,
    });
    await insertEvent({
      requestId: null,
      executionId: 'exec-legacy-1',
      workflow: workflowName,
      eventType: 'workflow.error',
      message: '节点抛错',
      createdAt: startedAt + 1_000,
    });

    const executionId = await store.linkRunToErrorEvent({
      runId: 'run_legacy',
      workflowName,
      startedAt,
      requestId: 'req_legacy',
    });
    assert.equal(executionId, 'exec-legacy-1');

    const event = await database.d1
      .prepare(
        `SELECT request_id FROM n8n_events WHERE execution_id = 'exec-legacy-1'`,
      )
      .first<{ request_id: string | null }>();
    assert.equal(event?.request_id, 'req_legacy', '事件也要被补上 requestId');
  });

  it('时间窗之外的错误事件不会被误配', async () => {
    const workflowName = 'urtoris-wf-window';
    const startedAt = Date.now();
    await insertRun({
      id: 'run_window',
      requestId: 'req_window',
      workflowId: 'wf_window',
      workflowName,
      status: 'running',
      startedAt,
    });
    // 10 分钟前的事件：超出 ±2 分钟窗口
    await insertEvent({
      requestId: null,
      executionId: 'exec-way-old',
      workflow: workflowName,
      eventType: 'workflow.error',
      createdAt: startedAt - 600_000,
    });

    const executionId = await store.linkRunToErrorEvent({
      runId: 'run_window',
      workflowName,
      startedAt,
      requestId: 'req_window',
    });
    assert.equal(executionId, null, '宁可不匹配也不能乱匹配');
  });

  it('不同工作流的错误事件不会被跨工作流匹配', async () => {
    const workflowName = 'urtoris-wf-target';
    const startedAt = Date.now();
    await insertRun({
      id: 'run_cross',
      requestId: 'req_cross',
      workflowId: 'wf_cross',
      workflowName,
      status: 'running',
      startedAt,
    });
    await insertEvent({
      requestId: null,
      executionId: 'exec-other-wf',
      workflow: 'urtoris-wf-other',
      eventType: 'workflow.error',
      createdAt: startedAt + 500,
    });

    const executionId = await store.linkRunToErrorEvent({
      runId: 'run_cross',
      workflowName,
      startedAt,
      requestId: 'req_cross',
    });
    assert.equal(executionId, null);
  });

  it('同一 requestId 重试不产生第二次副作用（claim 只发一次）', async () => {
    const requestId = 'req_retry';
    const first = await import('@/lib/server/replay').then((module) =>
      module.claimRunRequest(requestId),
    );
    assert.equal(first.kind, 'claimed');

    const second = await import('@/lib/server/replay').then((module) =>
      module.claimRunRequest(requestId),
    );
    assert.equal(second.kind, 'in_progress');
    assert.equal(second.runId, first.runId, '第二次必须落到同一次运行');
  });

  it('失败 run 一旦落库，同 requestId 也必须重放而不是重新执行', async () => {
    const requestId = 'req_failed_replay';
    await insertRun({
      id: 'run_failed_replay',
      requestId,
      workflowId: 'wf_failed_replay',
      workflowName: '失败重放测试',
      status: 'failed',
      startedAt: Date.now(),
    });

    const existing = await store.getRunByRequestId(requestId);
    assert.ok(existing);
    const replay = await import('@/lib/server/replay');
    const decision = replay.decideReplay(existing, 'wf_failed_replay');
    assert.equal(decision.kind, 'replay');
    if (decision.kind === 'replay') {
      assert.equal(decision.run.id, 'run_failed_replay');
    }
  });
});
