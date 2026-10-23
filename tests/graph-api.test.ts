import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ADMIN_TOKEN,
  adminRequest,
  graphContext,
  installDatabaseMock,
  readJson,
  seedWorkflow,
} from './helpers/api';
import { env } from './helpers/cloudflare-workers-stub';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import { legacySteps, makeNode, validGraph } from './helpers/graph';
import type { WorkflowGraphV1 } from '@/lib/workflow-graph/types';

// 必须在动态 import route 之前完成替换
const database: TestDatabase = createTestDatabase();
installDatabaseMock(database.d1);

type GraphRoute = typeof import('@/app/api/workflows/[id]/graph/route');
let route!: GraphRoute;

type GraphGetResponse = {
  graph: WorkflowGraphV1;
  persisted: boolean;
  hash: string | null;
  issues: { level: string; message: string }[];
};

type GraphPutResponse = {
  graph?: WorkflowGraphV1;
  hash?: string;
  updatedAt?: number;
  issues?: { level: string; message: string }[];
  error?: string;
  currentRevision?: number;
  path?: string;
};

function graphUrl(id: string) {
  // 故意用非本机域名：本机/内网访问现在会被当成管理员会话（见 admin-trust.test.ts），
  // 这些用例要守的是"公网入口必须带令牌"。
  return `https://urtoris.test/api/workflows/${id}/graph`;
}

function draftFor(id: string): WorkflowGraphV1 {
  return { ...validGraph(), id };
}

async function put(id: string, graph: WorkflowGraphV1, expectedRevision: number) {
  return route.PUT(
    adminRequest(graphUrl(id), { body: { graph, expectedRevision } }),
    graphContext(id),
  );
}

async function get(id: string) {
  return route.GET(
    adminRequest(graphUrl(id), { headers: { 'X-Real-IP': '10.5.5.5' } }),
    graphContext(id),
  );
}

describe('Graph API', () => {
  before(async () => {
    env.URTORIS_ADMIN_TOKEN = ADMIN_TOKEN;
    route = await import('@/app/api/workflows/[id]/graph/route');
  });

  after(() => {
    database.close();
  });

  it('无令牌 / 错误令牌返回 401', async () => {
    await seedWorkflow(database.d1, { id: 'wf_auth', draftSteps: [] });
    const anonymous = await route.GET(
      adminRequest(graphUrl('wf_auth'), { token: null }),
      graphContext('wf_auth'),
    );
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('WWW-Authenticate'), 'Bearer');

    const wrong = await route.GET(
      adminRequest(graphUrl('wf_auth'), { token: 'not-the-token' }),
      graphContext('wf_auth'),
    );
    assert.equal(wrong.status, 401);
  });

  it('服务端未配置管理员令牌时返回 503，而不是放行', async () => {
    const saved = env.URTORIS_ADMIN_TOKEN;
    delete env.URTORIS_ADMIN_TOKEN;
    const response = await route.GET(
      adminRequest(graphUrl('wf_auth')),
      graphContext('wf_auth'),
    );
    assert.equal(response.status, 503);
    env.URTORIS_ADMIN_TOKEN = saved;
  });

  it('未知工作流返回 404', async () => {
    const response = await route.GET(
      adminRequest(graphUrl('wf_missing')),
      graphContext('wf_missing'),
    );
    assert.equal(response.status, 404);
  });

  it('GET 在无草稿时返回 legacy 投影，并标记 persisted=false', async () => {
    await seedWorkflow(database.d1, {
      id: 'wf_legacy',
      draftSteps: legacySteps(),
      publishedSteps: legacySteps(),
      n8nWebhookUrl: 'http://127.0.0.1:5678/webhook/urtoris/legacy',
    });
    const response = await get('wf_legacy');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = await readJson<GraphGetResponse>(response);
    assert.equal(body.persisted, false);
    assert.equal(body.hash, null);
    assert.equal(body.graph.metadata.source, 'legacy-steps');
    assert.equal(body.graph.runtime.binding, 'external');
    assert.deepEqual(body.issues, []);
  });

  it('PUT 保存草稿：revision 递增、返回稳定 hash 与 issues', async () => {
    await seedWorkflow(database.d1, { id: 'wf_save', draftSteps: legacySteps() });
    const response = await put('wf_save', draftFor('wf_save'), 0);
    assert.equal(response.status, 200);
    const body = await readJson<GraphPutResponse>(response);
    assert.equal(body.graph?.revision, 1);
    assert.match(body.hash ?? '', /^[0-9a-f]{64}$/);
    assert.deepEqual(body.issues, []);
  });

  it('保存后可读回，且 hash 与写入时一致（内容哈希稳定）', async () => {
    await seedWorkflow(database.d1, { id: 'wf_reread', draftSteps: legacySteps() });
    const response = await put('wf_reread', draftFor('wf_reread'), 0);
    const saved = await readJson<GraphPutResponse>(response);
    assert.equal(response.status, 200);

    const read = await get('wf_reread');
    const body = await readJson<GraphGetResponse>(read);
    assert.equal(body.persisted, true);
    assert.equal(body.graph.revision, 1);
    assert.equal(body.hash, saved.hash);
    assert.equal(
      JSON.stringify(body.graph),
      JSON.stringify(saved.graph),
      '读回的图必须与写入的图逐字一致',
    );
  });

  it('并发保存：同一个 expectedRevision 的第二次写入返回 409 与当前 revision', async () => {
    await seedWorkflow(database.d1, { id: 'wf_conflict', draftSteps: [] });
    const first = await put('wf_conflict', draftFor('wf_conflict'), 0);
    assert.equal(first.status, 200);

    const second = await put('wf_conflict', draftFor('wf_conflict'), 0);
    assert.equal(second.status, 409);
    const body = await readJson<GraphPutResponse>(second);
    assert.equal(body.currentRevision, 1);
    assert.match(body.error ?? '', /已被其他会话修改/);
  });

  it('revision 过期后提供最新 revision 即可继续保存', async () => {
    await seedWorkflow(database.d1, { id: 'wf_retry', draftSteps: [] });
    assert.equal((await put('wf_retry', draftFor('wf_retry'), 0)).status, 200);

    const conflict = await put('wf_retry', draftFor('wf_retry'), 0);
    assert.equal(conflict.status, 409);
    const { currentRevision } = await readJson<GraphPutResponse>(conflict);

    const retried = await put('wf_retry', draftFor('wf_retry'), currentRevision ?? -1);
    assert.equal(retried.status, 200);
    const body = await readJson<GraphPutResponse>(retried);
    assert.equal(body.graph?.revision, 2);
  });

  it('草稿允许半成品：缺 false 分支会保存成功并返回 issues', async () => {
    await seedWorkflow(database.d1, { id: 'wf_half', draftSteps: [] });
    const graph: WorkflowGraphV1 = {
      ...validGraph(),
      id: 'wf_half',
      name: '半成品草稿',
      nodes: [
        makeNode('trigger', 'node_0'),
        makeNode('condition', 'node_1'),
        makeNode('output', 'node_2'),
      ],
      edges: [
        {
          id: 'edge_a',
          kind: 'main',
          source: { nodeId: 'node_0', portId: 'main.out' },
          target: { nodeId: 'node_1', portId: 'main.in' },
        },
        {
          id: 'edge_b',
          kind: 'branch',
          source: { nodeId: 'node_1', portId: 'branch.true' },
          target: { nodeId: 'node_2', portId: 'main.in' },
          condition: { branch: 'true' },
        },
      ],
      entryNodeIds: ['node_0'],
    };
    const response = await put('wf_half', graph, 0);
    assert.equal(response.status, 200);
    const body = await readJson<GraphPutResponse>(response);
    assert.ok(
      body.issues?.some(
        (issue) => issue.level === 'error' && issue.message.includes('false 分支'),
      ),
    );
  });

  it('拒绝 graph.id 与 URL 不一致', async () => {
    const response = await put('wf_save', draftFor('other_workflow'), 0);
    assert.equal(response.status, 400);
  });

  it('拒绝畸形 Graph（端口缺失）', async () => {
    const graph = draftFor('wf_malformed') as unknown as {
      nodes: Record<string, unknown>[];
    };
    delete graph.nodes[1].ports;
    const response = await put(
      'wf_malformed',
      { ...graph, id: 'wf_malformed' } as unknown as WorkflowGraphV1,
      0,
    );
    assert.equal(response.status, 400);
  });

  it('拒绝内联凭据并返回命中的字段路径', async () => {
    const graph = draftFor('wf_secret');
    graph.nodes[1] = {
      ...graph.nodes[1],
      config: { authorization: 'Bearer abcdefghijklmnop1234' },
    };
    const response = await put('wf_secret', graph, 0);
    assert.equal(response.status, 400);
    const body = await readJson<GraphPutResponse>(response);
    assert.match(body.error ?? '', /不能保存 Key、密码或鉴权头/);
    assert.equal(body.path, '$.nodes[1].config.authorization');
  });

  it('接受 credentialRef 这类引用', async () => {
    await seedWorkflow(database.d1, { id: 'wf_cred', draftSteps: [] });
    const graph = draftFor('wf_cred');
    graph.nodes[1] = {
      ...graph.nodes[1],
      config: { credentialRef: 'n8n-header-auth' },
    };
    const response = await put('wf_cred', graph, 0);
    assert.equal(response.status, 200);
  });

  it('拒绝超长名称', async () => {
    const graph = { ...draftFor('wf_cred'), name: 'x'.repeat(81) };
    const response = await put('wf_cred', graph, 0);
    assert.equal(response.status, 400);
  });

  it('请求体超过 512 KB 返回 413', async () => {
    const graph = { ...draftFor('wf_cred'), description: 'x'.repeat(600 * 1024) };
    const response = await put('wf_cred', graph, 0);
    assert.equal(response.status, 413);
  });

  it('非法 JSON / 非对象请求体返回 400', async () => {
    const malformed = new Request(graphUrl('wf_save'), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Real-IP': '10.9.9.9',
      },
      body: '{ not json',
    });
    assert.equal((await route.PUT(malformed, graphContext('wf_save'))).status, 400);

    const arrayBody = new Request(graphUrl('wf_save'), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Real-IP': '10.9.9.8',
      },
      body: '[]',
    });
    assert.equal((await route.PUT(arrayBody, graphContext('wf_save'))).status, 400);
  });

  it('缺少 expectedRevision 返回 400', async () => {
    const response = await route.PUT(
      adminRequest(graphUrl('wf_save'), { body: { graph: draftFor('wf_save') } }),
      graphContext('wf_save'),
    );
    assert.equal(response.status, 400);
  });

  it('对不存在的工作流 PUT 返回 404', async () => {
    const response = await put('wf_none', draftFor('wf_none'), 0);
    assert.equal(response.status, 404);
  });

  it('限流触发后返回 429 与 Retry-After', async () => {
    let limited: Response | null = null;
    for (let index = 0; index < 100; index += 1) {
      const response = await route.GET(
        adminRequest(graphUrl('wf_save'), { headers: { 'X-Real-IP': '10.7.7.7' } }),
        graphContext('wf_save'),
      );
      if (response.status === 429) {
        limited = response;
        break;
      }
    }
    assert.ok(limited, '应当在 90 次读取内触发限流');
    assert.equal(limited.headers.get('X-RateLimit-Remaining'), '0');
    assert.ok(Number(limited.headers.get('Retry-After')) >= 1);
  });
});
