import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { buildWorkflowSystemPrompt } from '@/lib/server/llm';
import { installDatabaseMock, nextAddress, seedWorkflow } from './helpers/api';
import { resetEnv } from './helpers/cloudflare-workers-stub';
import { createTestDatabase } from './helpers/d1';
import { canaryGraph, legacySteps, legacyWorkflow } from './helpers/graph';

const database = createTestDatabase();
installDatabaseMock(database.d1);

const API_TOKEN = 'test-run-constraints-token';
const CONSTRAINED_ID = 'wf_run_constraints_published';
const DRAFT_ONLY_ID = 'wf_run_constraints_draft';
let runsRoute: typeof import('@/app/api/runs/route');
let v1Route: typeof import('@/app/api/v1/run/route');

function post(endpoint: string, workflowId: string): Request {
  return new Request(`https://urtoris.test${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_TOKEN}`,
      'X-Real-IP': nextAddress(),
    },
    body: JSON.stringify({
      workflowId,
      message: '执行工作流',
      // 这两个入口没有直连模型分支；提供 Key 也不能把模拟结果当成合规执行。
      llm: { apiKey: 'fake-model-key' },
      constraints: '',
    }),
  });
}

describe('模拟执行入口遵守已发布的 Agent 行为限制', () => {
  before(async () => {
    resetEnv({ URTORIS_API_TOKEN: API_TOKEN });
    const { saveWorkflowGraphDraft } =
      await import('@/lib/server/workflow-graph-store');
    const { publishWorkflowGraph } =
      await import('@/lib/server/workflow-version-store');

    for (const workflowId of [CONSTRAINED_ID, DRAFT_ONLY_ID]) {
      await seedWorkflow(database.d1, {
        id: workflowId,
        publishedSteps: legacySteps(),
        version: 1,
      });
      const graph = canaryGraph(workflowId);
      const agent = graph.nodes.find((node) => node.type === 'aiAgent');
      assert.ok(agent);
      agent.config.constraints =
        workflowId === CONSTRAINED_ID ? '只允许查询订单，不得删除数据。' : '';
      const saved = await saveWorkflowGraphDraft({
        workflowId,
        graph,
        expectedRevision: 0,
      });
      await publishWorkflowGraph({
        workflowId,
        expectedRevision: saved.graph.revision,
      });

      // 与发布版本反向修改草稿，验证运行时不会提前套用或解除草稿限制。
      agent.config.constraints =
        workflowId === CONSTRAINED_ID ? '' : '未发布的草稿：不得执行任何操作。';
      await saveWorkflowGraphDraft({
        workflowId,
        graph,
        expectedRevision: saved.graph.revision,
      });
    }
    runsRoute = await import('@/app/api/runs/route');
    v1Route = await import('@/app/api/v1/run/route');
  });

  after(() => database.close());

  for (const endpoint of ['/api/runs', '/api/v1/run']) {
    it(`${endpoint} 拒绝模拟已发布限制，草稿清空和客户端 Key 都不能绕过`, async () => {
      const handler = endpoint === '/api/runs' ? runsRoute : v1Route;
      const response = await handler.POST(post(endpoint, CONSTRAINED_ID));
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(response.status, 409);
      assert.equal(body.errorCode, 'AGENT_CONSTRAINTS_REQUIRE_MODEL');
      if (endpoint === '/api/v1/run') {
        assert.equal(body.ok, false);
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
      }
      const runs = await database.d1
        .prepare('SELECT COUNT(*) AS count FROM runs WHERE workflow_id = ?')
        .bind(CONSTRAINED_ID)
        .first<{ count: number }>();
      assert.equal(runs?.count, 0, '拒绝执行不能落库为成功运行');
    });

    it(`${endpoint} 保留无已发布限制的模拟兼容，草稿限制不提前生效`, async () => {
      const handler = endpoint === '/api/runs' ? runsRoute : v1Route;
      const response = await handler.POST(post(endpoint, DRAFT_ONLY_ID));
      const body = (await response.json()) as {
        envelope: { engine: string; mode: string; degraded: boolean };
      };
      assert.equal(response.status, 200);
      assert.equal(body.envelope.engine, 'simulated');
      assert.equal(body.envelope.mode, 'simulated');
      assert.equal(body.envelope.degraded, true);
    });
  }

  it('系统提示保留生产第二参数 options 调用的历史兼容', () => {
    const prompt = buildWorkflowSystemPrompt(legacyWorkflow(), {
      hasConversationHistory: true,
    });
    assert.match(prompt, /已提供当前聊天框中更早的完整记录/);
    assert.doesNotMatch(prompt, /本次没有更早的对话记录/);
  });

  it('系统提示可同时注入限制与历史说明', () => {
    const graph = canaryGraph();
    const agent = graph.nodes.find((node) => node.type === 'aiAgent');
    assert.ok(agent);
    agent.config.constraints = '不得删除订单。';
    const prompt = buildWorkflowSystemPrompt(legacyWorkflow(), graph, {
      hasConversationHistory: true,
    });
    assert.match(prompt, /已提供当前聊天框中更早的完整记录/);
    assert.match(prompt, /执行「AI 主管」对应步骤时/);
    assert.match(prompt, /不得删除订单/);
  });
});
