import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { installDatabaseMock, nextAddress, seedWorkflow } from './helpers/api';
import { resetEnv } from './helpers/cloudflare-workers-stub';
import { createTestDatabase } from './helpers/d1';
import { localDatabaseGraph } from './helpers/local-database-graph';
import type { DatabaseToolRequest } from '@/lib/server/database-agent';
import { createDatabaseBridge } from '@/services/database-bridge/server';

type Json = Record<string, unknown>;
type Pending = {
  mode: 'local-database';
  database: { session: string; requests: DatabaseToolRequest[] };
};
const database = createTestDatabase();
installDatabaseMock(database.d1);
const workflowId = 'wf_local_sqlite_end_to_end';
const pairingCode = 'a'.repeat(64);
const privateValue = 'PRIVATE_ROW_VALUE_MUST_STAY_IN_SQLITE';
const modelBodies: Json[] = [];
const modelPaths: string[] = [];
let directory = '';
let filePath = '';
let helperOrigin = '';
let modelOrigin = '';
let helper: ReturnType<typeof createDatabaseBridge>;
let model: ReturnType<typeof createServer>;
let chat: typeof import('@/app/api/agent/chat/route');

async function readJsonBody(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json;
}

async function handleModel(request: IncomingMessage, response: ServerResponse) {
  const body = await readJsonBody(request);
  modelBodies.push(body);
  modelPaths.push(request.url ?? '');
  const results = (body.messages as Json[]).filter(
    (entry) => entry.role === 'tool',
  );
  let tool: Json | undefined;
  let content: string | null = null;
  if (results.length === 0) {
    tool = {
      id: 'real_schema',
      type: 'function',
      function: {
        name: 'inspect_database',
        arguments: JSON.stringify({ nodeId: 'local_database' }),
      },
    };
  } else if (results.length === 1) {
    const schema = JSON.parse(String(results[0].content)) as {
      result: {
        tables: Array<{ name: string; columns: Array<{ name: string }> }>;
      };
    };
    assert.ok(schema.result.tables.some((table) => table.name === 'orders'));
    tool = {
      id: 'real_query',
      type: 'function',
      function: {
        name: 'query_database',
        arguments: JSON.stringify({
          nodeId: 'local_database',
          sql: 'SELECT name, total FROM orders WHERE total >= ? ORDER BY total DESC',
          parameters: [40],
        }),
      },
    };
  } else {
    const query = JSON.parse(String(results.at(-1)!.content)) as {
      result: { columns: string[]; rows: Array<[string, number]> };
    };
    assert.deepEqual(query.result.columns, ['name', 'total']);
    const total = query.result.rows.reduce((sum, row) => sum + row[1], 0);
    content = `订单数量 = ${query.result.rows.length}；总金额 = ${total}。\n结论 = 已核对订单；优先级 = 中`;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(
    JSON.stringify({
      model: 'real-sqlite-test-model',
      choices: [
        {
          message: {
            role: 'assistant',
            content,
            ...(tool ? { tool_calls: [tool] } : {}),
          },
        },
      ],
    }),
  );
}

function chatRequest(body: Json, cookie?: string) {
  return new Request('https://urtoris.cn/api/agent/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://urtoris.cn',
      'X-Real-IP': nextAddress(),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function bridgeResult(request: DatabaseToolRequest) {
  const payload =
    request.operation === 'inspect'
      ? { filePath: request.filePath }
      : {
          filePath: request.filePath,
          sql: request.sql,
          parameters: request.parameters,
          maxRows: request.maxRows,
        };
  const response = await fetch(`${helperOrigin}/v1/${request.operation}`, {
    method: 'POST',
    headers: {
      Origin: 'https://urtoris.cn',
      Authorization: `Bearer ${pairingCode}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const result = (await response.json()) as Json;
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(
    response.headers.get('Access-Control-Allow-Origin'),
    'https://urtoris.cn',
  );
  return { id: request.id, result };
}

describe('online chat → local HTTP helper → real SQLite → model reply', () => {
  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'urtoris-database-integration-'));
    filePath = join(directory, 'orders.sqlite');
    const source = new DatabaseSync(filePath);
    source.exec(
      'CREATE TABLE orders (name TEXT NOT NULL, total REAL NOT NULL, private_note TEXT NOT NULL)',
    );
    const insert = source.prepare('INSERT INTO orders VALUES (?, ?, ?)');
    insert.run('本地订单甲', 88, privateValue);
    insert.run('本地订单乙', 45, privateValue);
    insert.run('本地订单丙', 10, privateValue);
    source.close();
    helper = createDatabaseBridge({ token: pairingCode });
    await new Promise<void>((resolve) =>
      helper.listen(0, '127.0.0.1', resolve),
    );
    helperOrigin = `http://127.0.0.1:${(helper.address() as AddressInfo).port}`;
    model = createServer((request, response) => {
      void handleModel(request, response);
    });
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    modelOrigin = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
    resetEnv({
      URTORIS_API_TOKEN: 'real-sqlite-integration-signing-key',
      N8N_BASE_URL: modelOrigin,
    });
    await seedWorkflow(database.d1, { id: workflowId });
    const graph = localDatabaseGraph(workflowId, filePath);
    graph.nodes.find((node) => node.id === 'local_database')!.config.maxRows =
      2;
    graph.nodes.find((node) => node.id === 'local_model')!.config = {
      provider: 'custom',
      model: 'real-sqlite-test-model',
      baseUrl: `${modelOrigin}/v1`,
    };
    const { saveWorkflowGraphDraft } =
      await import('@/lib/server/workflow-graph-store');
    const { publishWorkflowGraph } =
      await import('@/lib/server/workflow-version-store');
    const saved = await saveWorkflowGraphDraft({
      workflowId,
      graph,
      expectedRevision: 0,
    });
    await publishWorkflowGraph({
      workflowId,
      expectedRevision: saved.graph.revision,
    });
    await database.d1
      .prepare('UPDATE workflows SET n8n_webhook_url = ? WHERE id = ?')
      .bind(`${modelOrigin}/webhook/legacy`, workflowId)
      .run();
    chat = await import('@/app/api/agent/chat/route');
  });

  after(async () => {
    if (helper)
      await new Promise<void>((resolve) => helper.close(() => resolve()));
    if (model)
      await new Promise<void>((resolve) => model.close(() => resolve()));
    database.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('reads only selected rows through the authenticated helper and saves only the final answer', async () => {
    const digest = (bytes: Buffer) =>
      createHash('sha256').update(bytes).digest('hex');
    const originalDigest = digest(await readFile(filePath));
    const body: Json = {
      workflowId,
      message: '查询金额不少于 40 的订单数量和总金额。',
      requestId: 'real-sqlite-chat-request',
      apiKey: 'real-sqlite-model-key',
      provider: 'custom',
      baseUrl: `${modelOrigin}/v1`,
      model: 'real-sqlite-test-model',
    };
    const {
      getOrCreateConsumerSession,
      upsertConsumerMessage,
      getConsumerMessage,
    } = await import('@/lib/server/consumer-store');
    const consumer = await getOrCreateConsumerSession(
      chatRequest(body),
      workflowId,
    );
    const cookie = consumer.setCookie!.split(';')[0];
    await upsertConsumerMessage(consumer.session, {
      id: 'real_sqlite_user',
      role: 'user',
      status: 'completed',
      text: String(body.message),
      createdAt: Date.now() - 1,
    });
    await upsertConsumerMessage(consumer.session, {
      id: 'real_sqlite_agent',
      role: 'agent',
      status: 'working',
      text: '',
      metadata: { chatRequestId: body.requestId },
      createdAt: Date.now(),
    });
    Object.assign(body, {
      consumerSessionId: consumer.session.id,
      sessionId: consumer.session.engineSessionId,
      agentMessageId: 'real_sqlite_agent',
      userMessageId: 'real_sqlite_user',
    });
    const firstResponse = await chat.POST(chatRequest(body, cookie));
    assert.equal(firstResponse.status, 200);
    const inspect = (await firstResponse.json()) as Pending;
    assert.equal(inspect.mode, 'local-database');
    assert.equal(inspect.database.requests[0].operation, 'inspect');
    assert.equal(inspect.database.requests[0].filePath, filePath);
    assert.equal(
      (await getConsumerMessage(consumer.session.id, 'real_sqlite_agent'))
        ?.status,
      'working',
    );
    assert.equal(
      (
        await database.d1
          .prepare('SELECT * FROM runs WHERE request_id = ?')
          .bind(body.requestId)
          .all()
      ).results.length,
      0,
    );
    const schema = await bridgeResult(inspect.database.requests[0]);
    const queryResponse = await chat.POST(
      chatRequest(
        {
          ...body,
          databaseSession: inspect.database.session,
          databaseResults: [schema],
        },
        cookie,
      ),
    );
    const query = (await queryResponse.json()) as Pending;
    assert.equal(queryResponse.status, 200, JSON.stringify(query));
    assert.equal(query.database.requests[0].operation, 'query');
    assert.equal(query.database.requests[0].maxRows, 2);
    const rows = await bridgeResult(query.database.requests[0]);
    assert.deepEqual(rows.result.rows, [
      ['本地订单甲', 88],
      ['本地订单乙', 45],
    ]);
    const finalResponse = await chat.POST(
      chatRequest(
        {
          ...body,
          databaseSession: query.database.session,
          databaseResults: [rows],
        },
        cookie,
      ),
    );
    const final = (await finalResponse.json()) as Json;
    assert.equal(finalResponse.status, 200, JSON.stringify(final));
    assert.equal(final.mode, 'model');
    assert.equal(final.degraded, false);
    assert.match(String(final.reply), /订单数量 = 2；总金额 = 133/);
    assert.equal(modelBodies.length, 3);
    assert.ok(modelPaths.every((path) => path === '/v1/chat/completions'));
    const modelTraffic = JSON.stringify(modelBodies);
    assert.ok(!modelTraffic.includes(privateValue));
    assert.ok(!modelTraffic.includes(pairingCode));
    assert.ok(!modelTraffic.includes('SQLite format 3'));
    assert.ok(modelTraffic.includes('本地订单甲'));
    const savedMessage = await getConsumerMessage(
      consumer.session.id,
      'real_sqlite_agent',
    );
    assert.equal(savedMessage?.status, 'completed');
    assert.match(savedMessage?.text ?? '', /总金额 = 133/);
    const savedRuns = await database.d1
      .prepare('SELECT * FROM runs WHERE request_id = ?')
      .bind(body.requestId)
      .all();
    assert.equal(savedRuns.results.length, 1);
    const retained = JSON.stringify({
      message: savedMessage,
      runs: savedRuns.results,
    });
    for (const excluded of [
      filePath,
      pairingCode,
      privateValue,
      '本地订单甲',
      'databaseSession',
      'real_query',
    ]) {
      assert.ok(!retained.includes(excluded), excluded);
    }
    assert.equal(digest(await readFile(filePath)), originalDigest);
    const replay = await chat.POST(chatRequest(body, cookie));
    assert.equal(((await replay.json()) as Json).replayed, true);
    assert.equal(modelBodies.length, 3);
  });
});
