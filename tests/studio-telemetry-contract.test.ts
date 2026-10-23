/**
 * Studio 轮询逻辑 × 真实遥测路由的契约测试。
 *
 * 断言的是**两边的字段名和游标语义**：路由返回的 `nodes` / `unmappedNodes` /
 * `hasMore` / `nextSeq` 必须能直接被 `lib/workflow-graph/telemetry.ts` 消费，
 * 而且分页折叠不能让已经拿到的 running/success 在收尾时被 waiting 打回去。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ADMIN_TOKEN,
  installDatabaseMock,
  nextAddress,
  seedWorkflow,
} from './helpers/api';
import { env } from './helpers/cloudflare-workers-stub';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import { canaryGraph } from './helpers/graph';
import {
  applyRunTelemetry,
  decideTelemetryPoll,
  type RunTelemetryPayload,
} from '@/lib/workflow-graph/telemetry';
import type { NodeRuntimeSnapshot } from '@/lib/workflow-graph/types';

const database: TestDatabase = createTestDatabase();
installDatabaseMock(database.d1);

type TelemetryRoute = typeof import('@/app/api/runs/[requestId]/telemetry/route');
type GraphStore = typeof import('@/lib/server/workflow-graph-store');
type VersionStore = typeof import('@/lib/server/workflow-version-store');

let telemetryRoute!: TelemetryRoute;
let graphStore!: GraphStore;
let versionStore!: VersionStore;

const WORKFLOW_ID = 'wf_studio_contract';

after(() => database.close());

let eventCounter = 0;
async function insertEvent(input: {
  requestId: string;
  eventType: string;
  node: string | null;
  durationMs?: number | null;
  message?: string;
  executionId?: string | null;
  payload?: unknown;
}): Promise<void> {
  eventCounter += 1;
  await database.d1
    .prepare(
      `INSERT INTO n8n_events (
         id, request_id, session_id, workflow, execution_id, level, event_type,
         node, message, payload_json, duration_ms, created_at
       ) VALUES (?, ?, NULL, ?, ?, 'info', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `studio_evt_${eventCounter}`,
      input.requestId,
      WORKFLOW_ID,
      input.executionId ?? 'exec_studio',
      input.eventType,
      input.node,
      input.message ?? '',
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.durationMs ?? null,
      Date.now() + eventCounter,
    )
    .run();
}

async function insertRun(input: {
  id: string;
  requestId: string;
  status: 'running' | 'completed' | 'failed';
}): Promise<void> {
  await database.d1
    .prepare(
      `INSERT INTO runs (
         id, workflow_id, workflow_name, workflow_version, status, steps_json,
         logs_json, output_json, started_at, finished_at, request_id, engine,
         execution_id, mode, degraded
       ) VALUES (?, ?, 'Studio 契约工作流', 1, ?, '[]', '[]', '{}', ?, ?, ?, 'n8n',
                 'exec_studio', 'rules', 0)`,
    )
    .bind(
      input.id,
      WORKFLOW_ID,
      input.status,
      1_700_000_000_000,
      input.status === 'running' ? null : 1_700_000_000_500,
      input.requestId,
    )
    .run();
}

function telemetryRequest(requestId: string, afterSeq: number): Request {
  return new Request(
    `http://localhost/api/runs/${requestId}/telemetry?afterSeq=${afterSeq}&limit=2`,
    {
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        'X-Real-IP': nextAddress(),
      },
    },
  );
}

/** 完全照 Studio 的做法跑一轮：游标翻页 → 折进 runtime → 按停止规则收工。 */
async function drainTelemetry(requestId: string) {
  let runtime: Record<string, NodeRuntimeSnapshot> = {};
  const unmapped = new Set<string>();
  let afterSeq = 0;
  let emptyPolls = 0;
  let rounds = 0;
  let stop: { reason: string; payload: RunTelemetryPayload } | null = null;

  for (; rounds < 12; rounds += 1) {
    const response = await telemetryRoute.GET(
      telemetryRequest(requestId, afterSeq),
      { params: Promise.resolve({ requestId }) },
    );
    assert.equal(response.status, 200);
    const payload = (await response.json()) as RunTelemetryPayload;

    runtime = applyRunTelemetry(runtime, payload.nodes);
    for (const name of payload.unmappedNodes ?? []) unmapped.add(name);
    emptyPolls = payload.events.length === 0 ? emptyPolls + 1 : 0;

    const decision = decideTelemetryPoll({ payload, emptyPolls, elapsedMs: 0 });
    if (decision.action === 'stop') {
      stop = { reason: decision.reason, payload };
      break;
    }
    afterSeq = decision.afterSeq;
  }

  return { runtime, unmapped, rounds, stop };
}

let bindings: { internalNodeId: string; externalNodeId: string }[] = [];

before(async () => {
  env.URTORIS_ADMIN_TOKEN = ADMIN_TOKEN;
  telemetryRoute = await import('@/app/api/runs/[requestId]/telemetry/route');
  graphStore = await import('@/lib/server/workflow-graph-store');
  versionStore = await import('@/lib/server/workflow-version-store');

  await seedWorkflow(database.d1, {
    id: WORKFLOW_ID,
    name: 'Studio 契约工作流',
    draftSteps: [],
  });
  await graphStore.saveWorkflowGraphDraft({
    workflowId: WORKFLOW_ID,
    graph: canaryGraph(WORKFLOW_ID),
    expectedRevision: 0,
    updatedBy: 'test',
  });
  const published = await versionStore.publishWorkflowGraph({
    workflowId: WORKFLOW_ID,
    expectedRevision: 1,
    publishedBy: 'test',
  });
  bindings = published.version.bindings;
});

describe('Studio 遥测轮询契约', () => {
  it('分页折叠不会把已到手的 success/running 打回 waiting，未映射节点跨页累积', async () => {
    const requestId = 'req_studio_paged';
    await insertRun({ id: 'run_studio_paged', requestId, status: 'completed' });

    const trigger = bindings.find(
      (binding) => binding.internalNodeId === 'node_trigger',
    );
    const agent = bindings.find(
      (binding) => binding.internalNodeId === 'node_agent',
    );
    const output = bindings.find(
      (binding) => binding.internalNodeId === 'node_out',
    );
    assert.ok(trigger && agent && output, '发布版本必须带出 canary 图的绑定');

    await insertEvent({
      requestId,
      eventType: 'execution.bound',
      node: trigger.externalNodeId,
      message: '绑定成功',
    });
    await insertEvent({
      requestId,
      eventType: 'node.started',
      node: trigger.externalNodeId,
    });
    await insertEvent({
      requestId,
      eventType: 'node.finished',
      node: trigger.externalNodeId,
      durationMs: 120,
    });
    await insertEvent({
      requestId,
      eventType: 'node.started',
      node: agent.externalNodeId,
    });
    // 这条事件来自一个没有绑定行的 n8n 节点：只能进 unmappedNodes，不能猜 nodeId。
    await insertEvent({
      requestId,
      eventType: 'node.finished',
      node: 'webhook-26',
      durationMs: 8,
    });

    const { runtime, unmapped, rounds, stop } = await drainTelemetry(requestId);

    assert.ok(stop, '轮询必须按停止规则收工');
    assert.equal(stop.reason, 'settled');
    assert.ok(rounds < 12, '不应撞上循环上限');
    assert.equal(stop.payload.binding, 'prebound');
    assert.equal(stop.payload.boundVersion, 1);
    assert.equal(stop.payload.bindingCount, bindings.length);

    // 关键断言：最后一页是空页，服务端会把所有"当页没有事件"的节点报成 waiting，
    // 客户端必须保留之前拿到的终态与 running。
    assert.equal(runtime.node_trigger?.state, 'success');
    assert.equal(runtime.node_trigger?.durationMs, 120);
    assert.equal(runtime.node_agent?.state, 'running');
    assert.equal(runtime.node_out?.state, 'waiting');

    assert.deepEqual([...unmapped], ['webhook-26']);
    // 空页只反映"当页事件"，所以它的 unmappedNodes 是空的 —— 这正是 Studio
    // 必须自己跨页累积未映射节点的原因。
    assert.deepEqual(stop.payload.unmappedNodes, []);
  });

  it('失败节点把原因一起带出接口，客户端可以直接渲染', async () => {
    const requestId = 'req_studio_error';
    await insertRun({ id: 'run_studio_error', requestId, status: 'failed' });
    const agent = bindings.find(
      (binding) => binding.internalNodeId === 'node_agent',
    );
    assert.ok(agent, '发布版本必须带出 node_agent 的绑定');

    await insertEvent({
      requestId,
      eventType: 'workflow.error',
      node: agent.externalNodeId,
      message: '[NODE_ERROR] 聚类节点炸了',
      payload: {
        code: 'NODE_ERROR',
        message: "Cannot read properties of undefined (reading 'indexOf')",
        detail: 'at tokenize (evalmachine:20:21)',
      },
    });

    const { runtime } = await drainTelemetry(requestId);
    const node = runtime.node_agent;
    assert.equal(node?.state, 'error');
    assert.equal(node?.errorCode, 'NODE_ERROR');
    assert.equal(
      node?.error,
      "Cannot read properties of undefined (reading 'indexOf')",
    );
    assert.ok(node?.errorDetail?.includes('tokenize'));
  });

  it('没有发布版本的运行不会凭空点亮节点', async () => {
    const legacyId = 'wf_studio_legacy';
    await seedWorkflow(database.d1, { id: legacyId, draftSteps: [] });
    const requestId = 'req_studio_legacy';
    await database.d1
      .prepare(
        `INSERT INTO runs (
           id, workflow_id, workflow_name, workflow_version, status, steps_json,
           logs_json, output_json, started_at, finished_at, request_id, engine,
           mode, degraded
         ) VALUES ('run_studio_legacy', ?, '无 Graph 版本', 1, 'completed', '[]',
                   '[]', '{}', 1, 2, ?, 'n8n', 'rules', 0)`,
      )
      .bind(legacyId, requestId)
      .run();
    eventCounter += 1;
    await database.d1
      .prepare(
        `INSERT INTO n8n_events (
           id, request_id, session_id, workflow, execution_id, level, event_type,
           node, message, payload_json, duration_ms, created_at
         ) VALUES (?, ?, NULL, ?, NULL, 'info', 'node.finished', 'webhook-26',
                   '', NULL, NULL, ?)`,
      )
      .bind(
        `studio_evt_${eventCounter}`,
        requestId,
        legacyId,
        Date.now() + eventCounter,
      )
      .run();

    const { runtime, unmapped, stop } = await drainTelemetry(requestId);
    assert.ok(stop);
    assert.equal(stop.payload.bindingCount, 0);
    assert.equal(stop.payload.nodes.length, 0, '没有绑定版本就没有画布节点可点亮');
    assert.deepEqual(runtime, {});
    assert.deepEqual([...unmapped], ['webhook-26']);
  });
});
