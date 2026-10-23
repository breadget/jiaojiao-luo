import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { installDatabaseMock, seedWorkflow } from './helpers/api';
import { env } from './helpers/cloudflare-workers-stub';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import { canaryGraph } from './helpers/graph';
import { EXECUTION_BOUND_EVENT } from '@/lib/server/node-telemetry';
import type { N8nWorkflow } from '@/lib/workflow-graph/adapter/types';

const database: TestDatabase = createTestDatabase();
installDatabaseMock(database.d1);

type EventsRoute = typeof import('@/app/api/n8n/events/route');
type TelemetryRoute =
  typeof import('@/app/api/runs/[requestId]/telemetry/route');
type GraphStore = typeof import('@/lib/server/workflow-graph-store');
type VersionStore = typeof import('@/lib/server/workflow-version-store');

let eventsRoute!: EventsRoute;
let telemetryRoute!: TelemetryRoute;
let graphStore!: GraphStore;
let versionStore!: VersionStore;

const INTERNAL_TOKEN = 'test-internal-token';
const WORKFLOW_ID = 'wf_bind';
const TOOLCHAIN_BINDING_FIXTURE = process.env.URTORIS_TOOLCHAIN_GENERATED_DIR
  ? join(
      process.env.URTORIS_TOOLCHAIN_GENERATED_DIR,
      'urtoris-wf-llm-smoke.json',
    )
  : null;

after(() => database.close());

function post(body: unknown): Promise<Response> {
  return eventsRoute.POST(
    new Request('http://localhost/api/n8n/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

/** 把 Canary 图发布成 v1，从而写出一套真实的 workflow_node_bindings。只做一次。 */
let canaryCache: { triggerNodeId: string; triggerName: string } | null = null;

async function publishCanary(): Promise<{
  triggerNodeId: string;
  triggerName: string;
}> {
  if (canaryCache) return canaryCache;
  await seedWorkflow(database.d1, { id: WORKFLOW_ID, draftSteps: [] });
  await graphStore.saveWorkflowGraphDraft({
    workflowId: WORKFLOW_ID,
    graph: canaryGraph(WORKFLOW_ID),
    expectedRevision: 0,
    updatedBy: 'test',
  });
  const result = await versionStore.publishWorkflowGraph({
    workflowId: WORKFLOW_ID,
    expectedRevision: 1,
    publishedBy: 'test',
  });
  const trigger = result.version.bindings.find(
    (binding) => binding.internalNodeId === 'node_trigger',
  );
  assert.ok(trigger, '发布版本里应当有 trigger 的绑定');
  canaryCache = {
    triggerNodeId: trigger.externalNodeId,
    triggerName: trigger.externalNodeName,
  };
  return canaryCache;
}

async function countBindings(executionId: string) {
  const row = await database.d1
    .prepare(
      `SELECT COUNT(*) AS total FROM n8n_execution_map WHERE execution_id = ?`,
    )
    .bind(executionId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function eventRow(id: string) {
  return database.d1
    .prepare(
      `SELECT request_id, node, event_type, payload_json FROM n8n_events WHERE id = ?`,
    )
    .bind(id)
    .first<{
      request_id: string | null;
      node: string | null;
      event_type: string;
      payload_json: string | null;
    }>();
}

async function latestEventFor(requestId: string) {
  return database.d1
    .prepare(
      `SELECT rowid AS seq, request_id, node, event_type, payload_json
       FROM n8n_events WHERE request_id = ? ORDER BY rowid DESC LIMIT 1`,
    )
    .bind(requestId)
    .first<{
      seq: number;
      request_id: string;
      node: string | null;
      event_type: string;
      payload_json: string | null;
    }>();
}

describe('提前绑定：execution.bound', () => {
  before(async () => {
    env.URTORIS_INTERNAL_TOKEN = INTERNAL_TOKEN;
    env.URTORIS_ADMIN_TOKEN = 'test-admin-token';
    eventsRoute = await import('@/app/api/n8n/events/route');
    telemetryRoute = await import('@/app/api/runs/[requestId]/telemetry/route');
    graphStore = await import('@/lib/server/workflow-graph-store');
    versionStore = await import('@/lib/server/workflow-version-store');
  });

  it('失败测试：缺少 executionId 时返回 400 BINDING_INVALID（n8n 守卫据此停止）', async () => {
    const response = await post({
      requestId: 'req_missing_exec',
      workflowId: WORKFLOW_ID,
      triggerNodeId: 'whatever',
      eventType: EXECUTION_BOUND_EVENT,
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as {
      ok: boolean;
      code?: string;
      error?: string;
    };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'BINDING_INVALID');
    assert.match(body.error ?? '', /executionId/);

    // 关键：失败的绑定**不能**留下任何映射
    assert.equal(await countBindings('undefined'), 0);
    const rows = await database.d1
      .prepare(`SELECT COUNT(*) AS total FROM n8n_events WHERE request_id = ?`)
      .bind('req_missing_exec')
      .first<{ total: number }>();
    assert.equal(rows?.total, 0, '绑定失败不应写入任何事件');
  });

  it('失败测试：缺少 requestId 同样返回 BINDING_INVALID', async () => {
    const response = await post({
      requestId: '',
      executionId: 'exec-no-request',
      workflowId: WORKFLOW_ID,
      eventType: EXECUTION_BOUND_EVENT,
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, 'BINDING_INVALID');
  });

  it('成功：写入 requestId ↔ executionId，并把 triggerNodeId 通过绑定表映射到内部 nodeId', async () => {
    const { triggerNodeId } = await publishCanary();
    const response = await post({
      requestId: 'req_bound_ok',
      executionId: 'exec-bound-ok',
      workflowId: WORKFLOW_ID,
      triggerNodeId,
      eventType: EXECUTION_BOUND_EVENT,
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      ok: boolean;
      bound: boolean;
      stored: number;
    };
    assert.equal(body.ok, true);
    assert.equal(body.bound, true, '2xx + bound:true 是守卫节点放行的唯一依据');
    assert.equal(body.stored, 1);

    assert.equal(
      await countBindings('exec-bound-ok'),
      1,
      'n8n_execution_map 必须落下',
    );

    const latest = await latestEventFor('req_bound_ok');
    assert.equal(latest?.event_type, EXECUTION_BOUND_EVENT);
    const payload = JSON.parse(latest?.payload_json ?? '{}') as {
      triggerNodeId?: string;
      internalNodeId?: string | null;
    };
    assert.equal(payload.triggerNodeId, triggerNodeId);
    assert.equal(
      payload.internalNodeId,
      'node_trigger',
      '映射只能来自 workflow_node_bindings',
    );
  });

  it('第 9 条：execution.bound 是这次运行的第一条节点事件（先于任何危险节点事件）', async () => {
    const { triggerNodeId } = await publishCanary();
    const requestId = 'req_order';
    await post({
      requestId,
      executionId: 'exec-order',
      workflowId: WORKFLOW_ID,
      triggerNodeId,
      eventType: EXECUTION_BOUND_EVENT,
    });
    // 随后才是危险节点（Agent / Tool / HTTP）
    await post({
      requestId,
      executionId: 'exec-order',
      workflowId: WORKFLOW_ID,
      eventType: 'node.started',
      node: 'U::node_agent::primary',
    });
    await post({
      requestId,
      executionId: 'exec-order',
      workflowId: WORKFLOW_ID,
      eventType: 'node.started',
      node: 'U::node_tool::tool',
    });

    const rows = await database.d1
      .prepare(
        `SELECT event_type, node FROM n8n_events WHERE request_id = ? ORDER BY rowid ASC`,
      )
      .bind(requestId)
      .all<{ event_type: string; node: string | null }>();
    const types = (rows.results ?? []).map((row) => row.event_type);
    assert.equal(types[0], EXECUTION_BOUND_EVENT, '绑定必须是第一条');
    assert.ok(
      !types.slice(1).includes(EXECUTION_BOUND_EVENT),
      '绑定事件不能出现在危险节点事件之后',
    );
  });

  it('有了提前绑定，后面的错误事件按 executionId 精确归位（不走时间窗）', async () => {
    const { triggerNodeId } = await publishCanary();
    const requestId = 'req_exact';
    await post({
      requestId,
      executionId: 'exec-exact',
      workflowId: WORKFLOW_ID,
      triggerNodeId,
      eventType: EXECUTION_BOUND_EVENT,
    });

    // Error Workflow 拿不到 requestId 的经典场景
    const response = await post({
      executionId: 'exec-exact',
      workflow: 'urtoris-wf-bound',
      eventType: 'workflow.error',
      message: '节点抛错',
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ids: string[] };
    const stored = await eventRow(body.ids[0]);
    assert.equal(
      stored?.request_id,
      requestId,
      '应当由 n8n_execution_map 精确补链，而不是靠 ±2 分钟窗口',
    );
  });

  it('没有 execution.bound 的运行被标记为 legacy（仍允许 fallback，但不假装可靠）', async () => {
    // 运行记录要先存在，遥测接口才认这个 requestId
    await database.d1
      .prepare(
        `INSERT INTO runs (
           id, workflow_id, workflow_name, workflow_version, status, steps_json,
           logs_json, output_json, started_at, finished_at, request_id, engine,
           mode, degraded
         ) VALUES ('run_legacy', ?, 'urtoris-wf-legacy', 1, 'completed', '[]', '[]',
                   '{}', 1, 2, 'req_legacy_kind', 'n8n', 'rules', 0)`,
      )
      .bind(WORKFLOW_ID)
      .run();

    const response = await telemetryRoute.GET(
      new Request('http://localhost/api/runs/req_legacy_kind/telemetry', {
        headers: {
          Authorization: 'Bearer test-admin-token',
          'X-Real-IP': '10.3.3.3',
        },
      }),
      { params: Promise.resolve({ requestId: 'req_legacy_kind' }) },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      binding: string;
      nodes: unknown[];
    };
    assert.equal(body.binding, 'legacy');
  });

  it('有 execution.bound 的运行在遥测里标记为 prebound', async () => {
    const { triggerNodeId } = await publishCanary();
    const requestId = 'req_prebound';
    await post({
      requestId,
      executionId: 'exec-prebound',
      workflowId: WORKFLOW_ID,
      triggerNodeId,
      eventType: EXECUTION_BOUND_EVENT,
    });
    await database.d1
      .prepare(
        `INSERT INTO runs (
           id, workflow_id, workflow_name, workflow_version, status, steps_json,
           logs_json, output_json, started_at, finished_at, request_id,
           execution_id, engine, mode, degraded
         ) VALUES ('run_prebound', ?, 'urtoris-wf-bound', 1, 'running', '[]', '[]',
                   '{}', 1, NULL, ?, 'exec-prebound', 'n8n', 'llm', 0)`,
      )
      .bind(WORKFLOW_ID, requestId)
      .run();

    const response = await telemetryRoute.GET(
      new Request(`http://localhost/api/runs/${requestId}/telemetry`, {
        headers: {
          Authorization: 'Bearer test-admin-token',
          'X-Real-IP': '10.3.3.4',
        },
      }),
      { params: Promise.resolve({ requestId }) },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      binding: string;
      boundVersion: number | null;
      nodes: { nodeId: string; state: string }[];
      unmappedNodes: string[];
    };
    assert.equal(body.binding, 'prebound');
    assert.equal(body.boundVersion, 1, '遥测必须绑定到当前生效的发布版本');
    // 绑定事件只映射到 trigger；其余节点没有事件 → waiting
    const trigger = body.nodes.find((node) => node.nodeId === 'node_trigger');
    assert.ok(trigger);
    assert.equal(
      body.nodes.every((node) => node.state === 'waiting'),
      true,
      '只有绑定事件时，没有节点应该被“点亮”',
    );
  });

  it('triggerNodeId 不在绑定表里时，internalNodeId 为 null 且进 unmappedNodes', async () => {
    const { triggerNodeId } = await publishCanary();
    assert.ok(triggerNodeId);
    const requestId = 'req_unmapped';
    await post({
      requestId,
      executionId: 'exec-unmapped',
      workflowId: WORKFLOW_ID,
      triggerNodeId: 'n8n-node-not-in-bindings',
      eventType: EXECUTION_BOUND_EVENT,
    });

    const latest = await latestEventFor(requestId);
    const payload = JSON.parse(latest?.payload_json ?? '{}') as {
      internalNodeId?: string | null;
    };
    assert.equal(payload.internalNodeId, null, '绝不允许猜一个 nodeId');

    await database.d1
      .prepare(
        `INSERT INTO runs (
           id, workflow_id, workflow_name, workflow_version, status, steps_json,
           logs_json, output_json, started_at, finished_at, request_id, engine,
           mode, degraded
         ) VALUES ('run_unmapped', ?, 'urtoris-wf-bound', 1, 'completed', '[]', '[]',
                   '{}', 1, 2, ?, 'n8n', 'llm', 0)`,
      )
      .bind(WORKFLOW_ID, requestId)
      .run();

    const response = await telemetryRoute.GET(
      new Request(`http://localhost/api/runs/${requestId}/telemetry`, {
        headers: {
          Authorization: 'Bearer test-admin-token',
          'X-Real-IP': '10.3.3.5',
        },
      }),
      { params: Promise.resolve({ requestId }) },
    );
    const body = (await response.json()) as { unmappedNodes: string[] };
    assert.deepEqual(body.unmappedNodes, ['n8n-node-not-in-bindings']);
  });

  it('旧生成器的 unknown requestId 哨兵必须被拒绝，避免多次执行串到伪 ID', async () => {
    // 当前生成器在绑定前先校验 requestId，且绑定 body 明确禁止 unknown 回退。
    // 站点反向拒绝这个旧哨兵，跨仓库任一侧回归都会响亮地 fail-closed。
    const response = await post({
      requestId: 'unknown',
      executionId: 'exec-unknown-request',
      workflowId: WORKFLOW_ID,
      triggerNodeId: 'webhook-26',
      eventType: EXECUTION_BOUND_EVENT,
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { ok: boolean; code?: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'BINDING_INVALID');
    assert.equal(await countBindings('exec-unknown-request'), 0);
  });

  it(
    '生成器实际发送的五个字段名与站点契约逐字一致',
    {
      skip:
        !TOOLCHAIN_BINDING_FIXTURE || !existsSync(TOOLCHAIN_BINDING_FIXTURE)
          ? '设置 URTORIS_TOOLCHAIN_GENERATED_DIR 后运行跨仓库产物契约'
          : false,
    },
    async () => {
      // 从真实产物里把 jsonBody 表达式抠出来，断言它只发这五个键，
      // 防止两侧字段名各改各的。
      const workflow = JSON.parse(
        readFileSync(TOOLCHAIN_BINDING_FIXTURE!, 'utf8'),
      ) as N8nWorkflow;
      const reporter = workflow.nodes.find((node) =>
        node.name.startsWith('绑定执行'),
      );
      assert.ok(reporter, '生成的产物里应当有绑定上报节点');
      const rawBody = reporter.parameters.jsonBody;
      const jsonBody = typeof rawBody === 'string' ? rawBody : '';
      for (const field of [
        'requestId',
        'executionId',
        'workflowId',
        'triggerNodeId',
        "eventType: 'execution.bound'",
      ]) {
        assert.ok(jsonBody.includes(field), `上报表达式缺少 ${field}`);
      }
    },
  );

  it('用户给的示例载荷逐字可用，且 node 可作为 triggerNodeId 的别名', async () => {
    // 与需求原文一致的载荷形状（用 node 而不是 triggerNodeId）
    const response = await post({
      requestId: 'req_123',
      executionId: '772',
      workflowId: WORKFLOW_ID,
      eventType: 'execution.bound',
      node: 'U::trigger::execution-binding',
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; bound: boolean };
    assert.deepEqual(
      { ok: body.ok, bound: body.bound },
      { ok: true, bound: true },
      '必须返回 { ok: true, bound: true }',
    );

    const latest = await latestEventFor('req_123');
    assert.equal(
      latest?.node,
      'U::trigger::execution-binding',
      'node 别名要按 triggerNodeId 存下来',
    );
  });

  it('重复上报同一绑定是幂等的：不报错、不新增映射、bound 仍为 true', async () => {
    const payload = {
      requestId: 'req_idem',
      executionId: 'exec-idem',
      workflowId: WORKFLOW_ID,
      triggerNodeId: 'webhook-26',
      eventType: EXECUTION_BOUND_EVENT,
    };
    const first = await post(payload);
    assert.equal(first.status, 200);
    const second = await post(payload);
    assert.equal(second.status, 200);
    const body = (await second.json()) as { ok: boolean; bound: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.bound, true);

    assert.equal(await countBindings('exec-idem'), 1, '只能有一条映射');

    const latest = await latestEventFor('req_idem');
    const parsed = JSON.parse(latest?.payload_json ?? '{}') as {
      created?: boolean;
    };
    assert.equal(parsed.created, false, '第二次上报应标记 created:false');
  });

  it('executionId 冲突不得覆盖已有绑定，返回 409 BINDING_CONFLICT', async () => {
    const first = await post({
      requestId: 'req_owner',
      executionId: 'exec-conflict',
      workflowId: WORKFLOW_ID,
      triggerNodeId: 'webhook-26',
      eventType: EXECUTION_BOUND_EVENT,
    });
    assert.equal(first.status, 200);

    const second = await post({
      requestId: 'req_intruder',
      executionId: 'exec-conflict',
      workflowId: WORKFLOW_ID,
      triggerNodeId: 'webhook-26',
      eventType: EXECUTION_BOUND_EVENT,
    });
    assert.equal(second.status, 409);
    const body = (await second.json()) as {
      ok: boolean;
      code?: string;
      existingRequestId?: string;
    };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'BINDING_CONFLICT');
    assert.equal(body.existingRequestId, 'req_owner');

    // 关键：旧绑定必须原封不动
    const row = await database.d1
      .prepare(
        `SELECT request_id FROM n8n_execution_map WHERE execution_id = ?`,
      )
      .bind('exec-conflict')
      .first<{ request_id: string }>();
    assert.equal(row?.request_id, 'req_owner', '冲突时绝不允许覆盖');
  });

  it('方向要分清：绑定入口允许同一 requestId 对应多个 executionId（不是 409）', async () => {
    // db/schema.ts 的 n8nExecutionMap 注释写得很清楚：
    //   "一个 requestId 在重试时可对应多个 executionId，所以只约束 executionId 唯一"
    // 这里描述的是 n8n 内部受控重试、或传输结果不确定后收到的第二个真实 execution。
    // 对外 API 的重复 requestId 若已有 run，会幂等重放，绝不会借此再次触发 n8n。
    const first = await post({
      requestId: 'req_retry_bind',
      executionId: 'exec-retry-1',
      workflowId: WORKFLOW_ID,
      triggerNodeId: 'webhook-26',
      eventType: EXECUTION_BOUND_EVENT,
    });
    assert.equal(first.status, 200);

    const second = await post({
      requestId: 'req_retry_bind',
      executionId: 'exec-retry-2',
      workflowId: WORKFLOW_ID,
      triggerNodeId: 'webhook-26',
      eventType: EXECUTION_BOUND_EVENT,
    });
    assert.equal(
      second.status,
      200,
      '同一 requestId 的新 executionId 必须被接受',
    );
    const body = (await second.json()) as { ok: boolean; bound: boolean };
    assert.deepEqual(
      { ok: body.ok, bound: body.bound },
      { ok: true, bound: true },
    );

    // 两条映射都要在，而且互不覆盖
    const rows = await database.d1
      .prepare(
        `SELECT execution_id, request_id FROM n8n_execution_map
         WHERE request_id = ? ORDER BY execution_id`,
      )
      .bind('req_retry_bind')
      .all<{ execution_id: string; request_id: string }>();
    assert.deepEqual(
      (rows.results ?? []).map((row) => row.execution_id),
      ['exec-retry-1', 'exec-retry-2'],
      '同一请求的两条真实 executionId 都应保留',
    );
  });

  it('反方向才是冲突：同一 executionId 绑到不同 requestId 必须 409（已在上面覆盖）', async () => {
    // 这条只是把两个方向的语义钉在一起，避免以后有人"修反了"。
    const a = await post({
      requestId: 'req_dir_a',
      executionId: 'exec-dir',
      workflowId: WORKFLOW_ID,
      eventType: EXECUTION_BOUND_EVENT,
    });
    assert.equal(a.status, 200);
    const b = await post({
      requestId: 'req_dir_b',
      executionId: 'exec-dir',
      workflowId: WORKFLOW_ID,
      eventType: EXECUTION_BOUND_EVENT,
    });
    assert.equal(b.status, 409);
  });

  it('未知 workflowId 被拒绝（404 BINDING_UNKNOWN_WORKFLOW）', async () => {
    const response = await post({
      requestId: 'req_unknown_wf',
      executionId: 'exec-unknown-wf',
      workflowId: 'urtoris-wf-llm-smoke', // n8n 侧的 id，不是站点侧的工作流 id
      triggerNodeId: 'webhook-26',
      eventType: EXECUTION_BOUND_EVENT,
    });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { ok: boolean; code?: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'BINDING_UNKNOWN_WORKFLOW');
    assert.equal(
      await countBindings('exec-unknown-wf'),
      0,
      '拒绝时不得留下映射',
    );
  });

  it('错误内部令牌返回 401', async () => {
    const response = await eventsRoute.POST(
      new Request('http://localhost/api/n8n/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer totally-wrong-token',
        },
        body: JSON.stringify({
          requestId: 'req_bad_token',
          executionId: 'exec-bad-token',
          workflowId: WORKFLOW_ID,
          eventType: EXECUTION_BOUND_EVENT,
        }),
      }),
    );
    assert.equal(response.status, 401);
    assert.equal(await countBindings('exec-bad-token'), 0);
  });

  it('execution.bound 能在事件查询接口（GET）里读到', async () => {
    const requestId = 'req_query';
    await post({
      requestId,
      executionId: 'exec-query',
      workflowId: WORKFLOW_ID,
      triggerNodeId: 'webhook-26',
      eventType: EXECUTION_BOUND_EVENT,
    });

    const response = await eventsRoute.GET(
      new Request(`http://localhost/api/n8n/events?requestId=${requestId}`, {
        headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
      }),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      ok: boolean;
      events: {
        eventType: string;
        requestId: string | null;
        executionId: string | null;
      }[];
    };
    assert.equal(body.ok, true);
    const bound = body.events.find(
      (event) => event.eventType === EXECUTION_BOUND_EVENT,
    );
    assert.ok(bound, 'GET 必须能读回 execution.bound');
    assert.equal(bound.requestId, requestId);
    assert.equal(bound.executionId, 'exec-query');
  });

  it('未配置内部令牌时事件写入返回 503（fail closed）', async () => {
    const saved = env.URTORIS_INTERNAL_TOKEN;
    delete env.URTORIS_INTERNAL_TOKEN;
    const response = await post({
      requestId: 'req_no_token',
      executionId: 'exec-no-token',
      workflowId: WORKFLOW_ID,
      eventType: EXECUTION_BOUND_EVENT,
    });
    assert.equal(response.status, 503);
    env.URTORIS_INTERNAL_TOKEN = saved;
  });

  it('绑定节点与产物结构一致：n8n 侧要报的字段在夹具里都存在', async () => {
    // 这条把"n8n 侧应该发什么"钉进测试，避免生成器与接口漂移
    const workflow = JSON.parse(
      readFileSync(
        join(process.cwd(), 'tests/fixtures/canary-compiled.n8n.json'),
        'utf8',
      ),
    ) as N8nWorkflow;
    const trigger = workflow.nodes.find(
      (node) => node.name === 'U::node_trigger::primary',
    );
    assert.ok(trigger, '夹具里应当有 trigger 节点');
    assert.ok(trigger.id, 'execution.bound 需要 triggerNodeId');
    assert.equal(EXECUTION_BOUND_EVENT, 'execution.bound');
  });
});
