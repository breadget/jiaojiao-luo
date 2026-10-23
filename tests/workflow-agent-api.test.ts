import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import type { WorkflowGraphV1 } from '@/lib/workflow-graph/types';
import {
  ADMIN_TOKEN,
  adminRequest,
  installDatabaseMock,
  nextAddress,
  readJson,
  seedWorkflow,
} from './helpers/api';
import { resetEnv } from './helpers/cloudflare-workers-stub';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import { validGraph } from './helpers/graph';

const database: TestDatabase = createTestDatabase();
installDatabaseMock(database.d1);

type WorkflowAgentRoute = typeof import('@/app/api/workflows/agent/route');
type JsonRecord = Record<string, unknown>;

let route!: WorkflowAgentRoute;
let server!: ReturnType<typeof createServer>;
let serverOrigin = '';

function blueprintText() {
  return JSON.stringify({
    schemaVersion: 1,
    summary: '创建最小可编译 Agent 工作流。',
    name: 'Creator Agent 测试',
    description: '用于验证只读提案接口。',
    nodes: [
      {
        key: 'trigger',
        type: 'trigger',
        name: '接收请求',
        description: '读取 Webhook 输入。',
      },
      {
        key: 'agent',
        type: 'aiAgent',
        name: '处理 Agent',
        description: '调用模型处理任务。',
      },
      {
        key: 'model',
        type: 'llmModel',
        name: 'Qwen Plus',
        description: '模型资源。',
      },
      {
        key: 'memory',
        type: 'memory',
        name: '会话记忆',
        description: '按 sessionId 分区。',
      },
      {
        key: 'output',
        type: 'output',
        name: '返回结果',
        description: '回传处理结果。',
      },
    ],
    connections: [
      {
        sourceKey: 'trigger',
        sourcePort: 'main.out',
        targetKey: 'agent',
        targetPort: 'main.in',
      },
      {
        sourceKey: 'agent',
        sourcePort: 'main.out',
        targetKey: 'output',
        targetPort: 'main.in',
      },
      {
        sourceKey: 'agent',
        sourcePort: 'resource.model',
        targetKey: 'model',
        targetPort: 'model.provider',
      },
      {
        sourceKey: 'agent',
        sourcePort: 'resource.memory',
        targetKey: 'memory',
        targetPort: 'memory.provider',
      },
    ],
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readRequest(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRecord;
}

async function handleProvider(
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (request.url !== '/compatible-mode/v1/chat/completions') {
    sendJson(response, 404, { error: 'unexpected path' });
    return;
  }
  const body = await readRequest(request);
  const key = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  if (key === 'wrong-key') {
    sendJson(response, 401, { error: { message: 'invalid key' } });
    return;
  }
  sendJson(response, 200, {
    model: body.model ?? 'qwen-plus',
    choices: [
      {
        message: {
          role: 'assistant',
          content: key === 'malformed-key' ? '这不是 JSON' : blueprintText(),
        },
      },
    ],
  });
}

function post(body: JsonRecord, token: string | null = ADMIN_TOKEN) {
  return route.POST(
    adminRequest('http://urtoris.test/api/workflows/agent', {
      method: 'POST',
      token,
      headers: {
        Origin: 'http://urtoris.test',
        'X-Real-IP': nextAddress(),
      },
      body,
    }),
  );
}

describe('POST /api/workflows/agent', () => {
  before(async () => {
    server = createServer((request, response) => {
      void handleProvider(request, response).catch((cause: unknown) => {
        sendJson(response, 500, {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    serverOrigin = `http://127.0.0.1:${address.port}`;
    resetEnv({ URTORIS_ADMIN_TOKEN: ADMIN_TOKEN });
    await seedWorkflow(database.d1, {
      id: 'wf_agent_existing',
      draftSteps: [],
    });
    route = await import('@/app/api/workflows/agent/route');
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((cause) => (cause ? reject(cause) : resolve()));
    });
    database.close();
  });

  it('同源自带 Key 就能生成提案；跨站被拒；无来源必须带 API 令牌', async () => {
    const body = {
      mode: 'create',
      prompt: '创建一个 Agent 工作流',
      apiKey: 'valid-key',
      baseUrl: `${serverOrigin}/compatible-mode/v1`,
    };

    // 辅助 Agent 只生成提案、不读不写服务端数据，所以不再要求 Admin token：
    // 只要请求是同源浏览器发的、Key 是自己的，就能用。
    const sameOrigin = await post(body, null);
    assert.equal(sameOrigin.status, 200);

    const crossSite = await route.POST(
      adminRequest('http://urtoris.test/api/workflows/agent', {
        method: 'POST',
        headers: {
          Origin: 'http://evil.test',
          'Sec-Fetch-Site': 'cross-site',
        },
        body,
      }),
    );
    assert.equal(crossSite.status, 403);

    // 不是浏览器发来的（没有 Origin）就必须带有效的 API 令牌，不能匿名当代理用。
    const cli = await route.POST(
      new Request('http://urtoris.test/api/workflows/agent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Real-IP': nextAddress(),
        },
        body: JSON.stringify(body),
      }),
    );
    assert.equal(cli.status, 401);
  });

  it('新建模式只返回可编译提案，不会写入任何表', async () => {
    const workflowsBefore = database.raw
      .prepare('SELECT COUNT(*) AS total FROM workflows')
      .get() as { total: number };
    const response = await post({
      mode: 'create',
      prompt: '创建一个能记住上下文的 Agent 工作流',
      apiKey: 'valid-key',
      baseUrl: `${serverOrigin}/compatible-mode/v1`,
      model: 'qwen-plus',
    });
    const body = await readJson<{
      proposal: {
        graph: WorkflowGraphV1;
        compile: { ready: boolean; requiredCredentialRefs: string[] };
      };
      persisted: boolean;
      imported: boolean;
      adapterLocked: boolean;
    }>(response);
    const workflowsAfter = database.raw
      .prepare('SELECT COUNT(*) AS total FROM workflows')
      .get() as { total: number };
    const drafts = database.raw
      .prepare('SELECT COUNT(*) AS total FROM workflow_graph_drafts')
      .get() as { total: number };

    assert.equal(response.status, 200);
    assert.equal(body.proposal.graph.nodes.length, 5);
    assert.equal(body.proposal.compile.ready, true);
    assert.deepEqual(body.proposal.compile.requiredCredentialRefs, [
      'headerAuth',
      'openAiApi',
      'urtorisEventsHeaderAuth',
    ]);
    assert.equal(body.persisted, false);
    assert.equal(body.imported, false);
    assert.equal(body.adapterLocked, true);
    assert.equal(workflowsAfter.total, workflowsBefore.total);
    assert.equal(drafts.total, 0);
  });

  it('编辑模式校验目标工作流，也不会自动保存', async () => {
    const graph = { ...validGraph(), id: 'wf_agent_existing' };
    const response = await post({
      mode: 'edit',
      prompt: '把当前工作流改成使用 Agent 和 Qwen',
      graph,
      apiKey: 'valid-key',
      baseUrl: `${serverOrigin}/compatible-mode/v1`,
    });
    const body = await readJson<{
      proposal: { graph: WorkflowGraphV1 };
      persisted: boolean;
    }>(response);

    assert.equal(response.status, 200);
    assert.equal(body.proposal.graph.id, 'wf_agent_existing');
    assert.equal(body.proposal.graph.revision, graph.revision);
    assert.equal(body.persisted, false);
    assert.equal(
      database.raw
        .prepare(
          'SELECT COUNT(*) AS total FROM workflow_graph_drafts WHERE workflow_id = ?',
        )
        .get('wf_agent_existing')?.total,
      0,
    );
  });

  it('区分错误 Key 和模型格式异常，两者都 fail-closed', async () => {
    const wrongKey = await post({
      mode: 'create',
      prompt: '创建一个最小 Agent 工作流',
      apiKey: 'wrong-key',
      baseUrl: `${serverOrigin}/compatible-mode/v1`,
    });
    const wrongBody = await readJson<{
      code: string;
      upstreamStatus: number;
    }>(wrongKey);
    assert.equal(wrongKey.status, 502);
    assert.equal(wrongBody.code, 'LLM_ERROR');
    assert.equal(wrongBody.upstreamStatus, 401);

    const malformed = await post({
      mode: 'create',
      prompt: '创建一个最小 Agent 工作流',
      apiKey: 'malformed-key',
      baseUrl: `${serverOrigin}/compatible-mode/v1`,
    });
    const malformedBody = await readJson<{ code: string }>(malformed);
    assert.equal(malformed.status, 422);
    assert.equal(malformedBody.code, 'AGENT_INVALID_PROPOSAL');
  });
});
