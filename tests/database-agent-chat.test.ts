import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { installDatabaseMock, nextAddress, seedWorkflow } from './helpers/api';
import { env, resetEnv } from './helpers/cloudflare-workers-stub';
import { createTestDatabase } from './helpers/d1';
import { graphOf, makeEdge, makeNode } from './helpers/graph';
import { LOCAL_DATABASE_PROTOCOL } from '@/lib/local-database-protocol';
import type { DatabaseToolRequest } from '@/lib/server/database-agent';

const database = createTestDatabase();
installDatabaseMock(database.d1);
type Json = Record<string, unknown>;
type Pending = {
  mode: 'local-database';
  requestId: string;
  database: { session: string; requests: DatabaseToolRequest[] };
};
const workflowId = 'wf_local_database_chat';
const filePath = '/Users/test/private/orders.db';
const observed: Json[] = [];
let origin = '';
let upstream: ReturnType<typeof createServer>;
let chat: typeof import('@/app/api/agent/chat/route');
let runs: typeof import('@/app/api/runs/route');
let publicRun: typeof import('@/app/api/v1/run/route');
let requestNumber = 0;
let advanceModelClock: (() => void) | undefined;

async function readBody(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json;
}

function responseJson(response: ServerResponse, body: unknown) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function handleUpstream(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const body = await readBody(request);
  observed.push(body);
  const messages = body.messages as Array<Json>;
  const tools = messages.filter((message) => message.role === 'tool');
  const key = request.headers.authorization ?? '';
  if (key.includes('lifecycle-key')) advanceModelClock?.();
  const count = tools.length;
  let call: Json | null = null;
  if (key.includes('loop-key')) {
    call = {
      name: 'inspect_database',
      arguments: JSON.stringify({ nodeId: 'database_orders' }),
    };
  } else if (count === 0) {
    call = key.includes('override-key')
      ? {
          name: 'inspect_database',
          arguments: JSON.stringify({
            nodeId: 'database_orders',
            filePath: '/etc/passwd',
          }),
        }
      : {
          name: 'inspect_database',
          arguments: JSON.stringify({ nodeId: 'database_orders' }),
        };
  } else if (
    (count === 1 || (count === 2 && key.includes('lifecycle-key'))) &&
    !key.includes('override-key')
  ) {
    call = {
      name: 'query_database',
      arguments: JSON.stringify({
        nodeId: 'database_orders',
        sql: 'SELECT name, total FROM orders WHERE total > ?',
        parameters: [50],
      }),
    };
  }
  responseJson(response, {
    model: 'mock-sql-model',
    choices: [
      {
        message: {
          role: 'assistant',
          content: call
            ? null
            : '订单金额为 88。\n结论 = 已读取订单；优先级 = 中',
          ...(call
            ? {
                tool_calls: [
                  { id: `sql_call_${count}`, type: 'function', function: call },
                ],
              }
            : {}),
        },
      },
    ],
  });
}

function bodyFor(key = 'database-test-key'): Json {
  requestNumber += 1;
  return {
    workflowId,
    message: '查询金额超过 50 的订单。',
    requestId: `local-db-request-${requestNumber}`,
    sessionId: 'local-db-session',
    apiKey: key,
    provider: 'custom',
    baseUrl: `${origin}/v1`,
    model: 'mock-sql-model',
  };
}

function request(
  body: Json,
  url = '/api/agent/chat',
  token?: string,
  cookie?: string,
): Request {
  return new Request(`http://urtoris.test${url}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://urtoris.test',
      'X-Real-IP': nextAddress(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function start(body: Json): Promise<Pending> {
  const response = await chat.POST(request(body));
  const payload = (await response.json()) as Pending;
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.mode, 'local-database');
  return payload;
}

function schemaResult(pending: Pending) {
  return [
    {
      id: pending.database.requests[0].id,
      result: {
        protocol: LOCAL_DATABASE_PROTOCOL,
        filePath,
        tables: [
          {
            name: 'orders',
            kind: 'table',
            columns: [
              {
                name: 'name',
                type: 'TEXT',
                nullable: false,
                primaryKey: false,
              },
              {
                name: 'total',
                type: 'REAL',
                nullable: false,
                primaryKey: false,
              },
            ],
            truncated: false,
          },
        ],
        truncated: false,
      },
    },
  ];
}

function queryResult(pending: Pending, rows: unknown[][] = [['订单一', 88]]) {
  return [
    {
      id: pending.database.requests[0].id,
      result: {
        protocol: LOCAL_DATABASE_PROTOCOL,
        columns: ['name', 'total'],
        rows,
        rowCount: rows.length,
        truncated: false,
      },
    },
  ];
}

async function continueWith(
  body: Json,
  pending: Pending,
  results: unknown,
): Promise<Response> {
  return chat.POST(
    request({
      ...body,
      databaseSession: pending.database.session,
      databaseResults: results,
    }),
  );
}

describe('published local SQLite Agent · browser query continuation', () => {
  before(async () => {
    upstream = createServer((request, response) => {
      void handleUpstream(request, response);
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    resetEnv({
      URTORIS_API_TOKEN: 'local-database-signing-test-token',
      N8N_BASE_URL: origin,
    });
    await seedWorkflow(database.d1, {
      id: workflowId,
      publishedSteps: [
        {
          id: 'agent',
          title: '查询订单',
          detail: '用真实数据库查询',
          kind: 'compose',
        },
      ],
      version: 1,
      n8nWebhookUrl: `${origin}/webhook/old-server-database`,
    });
    const graph = graphOf(
      [
        makeNode('trigger', 'trigger'),
        makeNode('aiAgent', 'agent', {
          config: {
            strategy: 'tools',
            instructions: '只查询订单的实际金额。',
            constraints: '不得查询密码或修改订单。',
            maxIterations: 6,
            fallbackPolicy: 'error',
            prompt: '$json.message',
          },
        }),
        makeNode('llmModel', 'model', {
          config: {
            provider: 'custom',
            model: 'mock-sql-model',
            baseUrl: `${origin}/v1`,
          },
        }),
        makeNode('database', 'database_orders', {
          name: '本机订单库',
          config: {
            provider: 'sqlite',
            location: 'local',
            operation: 'select',
            filePath,
            maxRows: 2,
          },
        }),
        makeNode('output', 'output'),
      ],
      [
        makeEdge('trigger', 'main.out', 'agent', 'main.in'),
        makeEdge('agent', 'main.out', 'output', 'main.in'),
        makeEdge('agent', 'resource.model', 'model', 'model.provider', 'model'),
        makeEdge(
          'agent',
          'resource.tools',
          'database_orders',
          'tool.provider',
          'tool',
        ),
      ],
      { id: workflowId },
    );
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
    // An old n8n binding must never override the local SQLite published snapshot.
    await database.d1
      .prepare('UPDATE workflows SET n8n_webhook_url = ? WHERE id = ?')
      .bind(`${origin}/webhook/old-server-database`, workflowId)
      .run();
    // Unpublished path edits cannot change the Agent's authorized file.
    graph.nodes.find((node) => node.id === 'database_orders')!.config.filePath =
      '/Users/test/unpublished.db';
    await saveWorkflowGraphDraft({
      workflowId,
      graph,
      expectedRevision: saved.graph.revision,
    });
    chat = await import('@/app/api/agent/chat/route');
    runs = await import('@/app/api/runs/route');
    publicRun = await import('@/app/api/v1/run/route');
  });

  after(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    database.close();
  });

  it('requests real schema and read-only SQL from the browser, preserves instructions, then persists and replays final reply', async () => {
    const body = bodyFor();
    const before = observed.length;
    const inspect = await start(body);
    assert.equal(inspect.database.requests[0].operation, 'inspect');
    assert.equal(inspect.database.requests[0].filePath, filePath);
    const sessionJson = Buffer.from(
      inspect.database.session.split('.')[0],
      'base64url',
    ).toString();
    assert.ok(!sessionJson.includes(String(body.apiKey)));
    const firstModel = observed[before];
    assert.equal(firstModel.max_tokens, 4096);
    const system = (firstModel.messages as Json[])
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    assert.match(system, /只查询订单的实际金额/);
    assert.match(system, /不得查询密码或修改订单/);
    const queryResponse = await continueWith(
      body,
      inspect,
      schemaResult(inspect),
    );
    const query = (await queryResponse.json()) as Pending;
    assert.equal(queryResponse.status, 200);
    assert.equal(query.database.requests[0].operation, 'query');
    assert.equal(query.database.requests[0].maxRows, 2);
    assert.deepEqual(query.database.requests[0].parameters, [50]);
    const final = await continueWith(body, query, queryResult(query));
    const payload = (await final.json()) as Json;
    assert.equal(final.status, 200);
    assert.equal(payload.mode, 'model');
    assert.equal(payload.degraded, false);
    assert.match(String(payload.reply), /88/);
    assert.equal((payload.run as Json).status, 'completed');
    const toolMessages = (observed.at(-1)!.messages as Json[]).filter(
      (message) => message.role === 'tool',
    );
    assert.match(String(toolMessages.at(-1)!.content), /订单一/);
    const count = observed.length;
    const replay = await chat.POST(request(body));
    assert.equal(((await replay.json()) as Json).replayed, true);
    assert.equal(observed.length, count);
    const rows = await database.d1
      .prepare('SELECT request_id, output_json FROM runs WHERE request_id = ?')
      .bind(body.requestId)
      .all();
    assert.equal(rows.results.length, 1);
    assert.ok(
      !String((rows.results[0] as Json).output_json).includes('订单一'),
    );
  });

  it('fails closed without a usable model, never simulates or invokes the legacy n8n URL', async () => {
    const body = bodyFor();
    delete body.apiKey;
    const count = observed.length;
    const response = await chat.POST(request(body));
    assert.equal(response.status, 409);
    assert.equal(
      ((await response.json()) as Json).errorCode,
      'LOCAL_DATABASE_REQUIRE_MODEL',
    );
    assert.equal(observed.length, count);
  });

  it('preserves full consumer history across tool rounds and saves the final Agent message', async () => {
    const {
      getOrCreateConsumerSession,
      upsertConsumerMessage,
      getConsumerMessage,
    } = await import('@/lib/server/consumer-store');
    const body = bodyFor();
    const consumer = await getOrCreateConsumerSession(
      request(body),
      workflowId,
    );
    const cookie = consumer.setCookie!.split(';')[0];
    const now = Date.now();
    const priorText = `历史订单备注：${'保留完整记录。'.repeat(300)}`;
    await upsertConsumerMessage(consumer.session, {
      id: 'db_history_user',
      role: 'user',
      status: 'completed',
      text: priorText,
      createdAt: now - 3,
    });
    await upsertConsumerMessage(consumer.session, {
      id: 'db_history_agent',
      role: 'agent',
      status: 'completed',
      text: '上次已核对订单资料。',
      metadata: { priority: '低' },
      createdAt: now - 2,
    });
    await upsertConsumerMessage(consumer.session, {
      id: 'db_current_user',
      role: 'user',
      status: 'completed',
      text: String(body.message),
      createdAt: now - 1,
    });
    await upsertConsumerMessage(consumer.session, {
      id: 'db_current_agent',
      role: 'agent',
      status: 'working',
      text: '',
      metadata: { chatRequestId: body.requestId },
      createdAt: now,
    });
    Object.assign(body, {
      consumerSessionId: consumer.session.id,
      sessionId: consumer.session.engineSessionId,
      agentMessageId: 'db_current_agent',
      userMessageId: 'db_current_user',
    });
    const inspect = (await (
      await chat.POST(request(body, undefined, undefined, cookie))
    ).json()) as Pending;
    const messages = observed.at(-1)!.messages as Json[];
    assert.ok(
      messages.some(
        (message) => message.role === 'user' && message.content === priorText,
      ),
    );
    assert.ok(
      messages.some(
        (message) =>
          message.role === 'assistant' &&
          String(message.content).includes('上次已核对订单资料。'),
      ),
    );
    const query = (await (
      await chat.POST(
        request(
          {
            ...body,
            databaseSession: inspect.database.session,
            databaseResults: schemaResult(inspect),
          },
          undefined,
          undefined,
          cookie,
        ),
      )
    ).json()) as Pending;
    assert.ok(
      (observed.at(-1)!.messages as Json[]).some(
        (message) => message.content === priorText,
      ),
    );
    const final = await chat.POST(
      request(
        {
          ...body,
          databaseSession: query.database.session,
          databaseResults: queryResult(query),
        },
        undefined,
        undefined,
        cookie,
      ),
    );
    assert.equal(final.status, 200);
    const saved = await getConsumerMessage(
      consumer.session.id,
      'db_current_agent',
    );
    assert.equal(saved?.status, 'completed');
    assert.match(saved?.text ?? '', /订单金额为 88/);
    assert.ok(!JSON.stringify(saved?.metadata).includes(filePath));
    assert.ok(!JSON.stringify(saved?.metadata).includes('订单一'));
  });

  it('rejects modified, mismatched and expired signed sessions before another model call', async () => {
    const body = bodyFor();
    const pending = await start(body);
    const count = observed.length;
    const [payload, signature] = pending.database.session.split('.');
    const changed = JSON.parse(
      Buffer.from(payload, 'base64url').toString(),
    ) as Json;
    changed.expiresAt = 1;
    const corrupt = {
      ...pending,
      database: {
        ...pending.database,
        session: `${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${signature}`,
      },
    };
    for (const [requestBody, token] of [
      [body, corrupt],
      [{ ...body, message: '另一个任务' }, pending],
      [{ ...body, requestId: 'another-request-123' }, pending],
    ] as Array<[Json, Pending]>) {
      const response = await continueWith(
        requestBody,
        token,
        schemaResult(pending),
      );
      assert.equal(response.status, 403);
      assert.equal(
        ((await response.json()) as Json).errorCode,
        'LOCAL_DATABASE_SESSION_INVALID',
      );
    }
    assert.equal(observed.length, count);
    const originalNow = Date.now;
    const originalState = JSON.parse(
      Buffer.from(payload, 'base64url').toString(),
    ) as { expiresAt: number };
    try {
      Date.now = () => originalState.expiresAt + 1;
      const expired = await continueWith(body, pending, schemaResult(pending));
      assert.equal(expired.status, 403);
      assert.equal(
        ((await expired.json()) as Json).errorCode,
        'LOCAL_DATABASE_SESSION_INVALID',
      );
    } finally {
      Date.now = originalNow;
    }
    assert.equal(observed.length, count);
  });

  it('rejects wrong IDs, duplicate IDs, result count and client path overrides', async () => {
    const body = bodyFor();
    const pending = await start(body);
    for (const results of [
      [],
      [{ id: 'wrong-id', result: {} }],
      [...schemaResult(pending), ...schemaResult(pending)],
      [{ ...schemaResult(pending)[0], filePath: '/etc/passwd' }],
    ]) {
      const response = await continueWith(body, pending, results);
      assert.equal(response.status, 400);
      assert.equal(
        ((await response.json()) as Json).errorCode,
        'LOCAL_DATABASE_RESULTS_INVALID',
      );
    }
    const override = await chat.POST(
      request({ ...body, filePath: '/etc/passwd' }),
    );
    assert.equal(override.status, 400);
  });

  it('rejects more rows than configured and oversized local results', async () => {
    const body = bodyFor();
    const inspect = await start(body);
    const query = (await (
      await continueWith(body, inspect, schemaResult(inspect))
    ).json()) as Pending;
    const overRows = await continueWith(
      body,
      query,
      queryResult(query, [
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ]),
    );
    assert.equal(overRows.status, 400);
    const overBytes = await continueWith(
      body,
      query,
      queryResult(query, [['x'.repeat(35 * 1024), 1]]),
    );
    assert.equal(overBytes.status, 413);
  });

  it('validates schema fields and typed SQLite cell values before sending them to the model', async () => {
    const body = bodyFor();
    const inspect = await start(body);
    const invalidSchema = schemaResult(inspect);
    invalidSchema[0].result.tables[0].columns[0].nullable =
      'no' as unknown as boolean;
    const before = observed.length;
    const malformedSchema = await continueWith(body, inspect, invalidSchema);
    assert.equal(malformedSchema.status, 400);
    assert.equal(observed.length, before);
    const query = (await (
      await continueWith(body, inspect, schemaResult(inspect))
    ).json()) as Pending;
    const queryCount = observed.length;
    for (const value of [
      { unexpected: 'object' },
      { type: 'integer', value: '0xff' },
      { type: 'blob', base64: 'AQ==', bytes: 2 },
      { type: 'blob', base64: '%invalid%', bytes: 1 },
    ]) {
      const malformedCell = await continueWith(
        body,
        query,
        queryResult(query, [[value, 88]]),
      );
      assert.equal(malformedCell.status, 400);
      assert.equal(observed.length, queryCount);
    }
    const accepted = await continueWith(
      body,
      query,
      queryResult(query, [
        [
          { type: 'integer', value: '9223372036854775807' },
          { type: 'blob', base64: 'AQ==', bytes: 1 },
        ],
      ]),
    );
    assert.equal(accepted.status, 200);
    assert.equal(observed.length, queryCount + 1);
  });

  it('revalidates signed pending tool paths against the graph before accepting results', async () => {
    const body = bodyFor();
    const pending = await start(body);
    const { getActiveWorkflowVersion } =
      await import('@/lib/server/workflow-version-store');
    const version = await getActiveWorkflowVersion(workflowId);
    assert.ok(version);
    const changedGraph = structuredClone(version.graph);
    changedGraph.nodes.find(
      (node) => node.id === 'database_orders',
    )!.config.filePath = '/Users/test/different-file.db';
    const state = JSON.parse(
      Buffer.from(
        pending.database.session.split('.')[0],
        'base64url',
      ).toString(),
    ) as {
      binding: import('@/lib/server/database-agent').DatabaseAgentBinding;
    };
    const { runDatabaseAgentTurn } =
      await import('@/lib/server/database-agent');
    const count = observed.length;
    await assert.rejects(
      runDatabaseAgentTurn({
        graph: changedGraph,
        binding: state.binding,
        messages: [],
        llm: {
          apiKey: String(body.apiKey),
          provider: 'custom',
          baseUrl: `${origin}/v1`,
          model: 'mock-sql-model',
        },
        databaseSession: pending.database.session,
        databaseResults: schemaResult(pending),
      }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'LOCAL_DATABASE_SESSION_INVALID',
    );
    assert.equal(observed.length, count);
  });

  it('surfaces a missing local helper as an actual failed run and replay preserves failure', async () => {
    const body = bodyFor();
    const pending = await start(body);
    const response = await continueWith(body, pending, [
      { id: pending.database.requests[0].id, error: '连接助手尚未启动。' },
    ]);
    const payload = (await response.json()) as Json;
    assert.equal(response.status, 502);
    assert.equal(payload.errorCode, 'LOCAL_DATABASE_UNAVAILABLE');
    assert.equal((payload.run as Json).status, 'failed');
    const replay = await chat.POST(request(body));
    assert.equal(replay.status, 502);
    assert.equal(((await replay.json()) as Json).replayed, true);
  });

  it('refuses model-generated path overrides and never hands them to the helper', async () => {
    const body = bodyFor('override-key');
    const response = await chat.POST(request(body));
    assert.equal(response.status, 200);
    const result = (await response.json()) as Json;
    assert.equal(result.mode, 'model');
    assert.equal(result.database, undefined);
    const toolMessage = (observed.at(-1)!.messages as Json[]).find(
      (message) => message.role === 'tool',
    );
    assert.match(String(toolMessage?.content), /不允许覆盖文件路径/);
  });

  it('bounds repeated database tool calls to six model turns', async () => {
    const body = bodyFor('loop-key');
    const before = observed.length;
    let response = await chat.POST(request(body));
    let payload = (await response.json()) as Json;
    while (payload.mode === 'local-database') {
      const pending = payload as unknown as Pending;
      response = await continueWith(body, pending, schemaResult(pending));
      payload = (await response.json()) as Json;
    }
    assert.equal(response.status, 502);
    assert.equal(payload.errorCode, 'LOCAL_DATABASE_TOOL_LIMIT');
    assert.equal(observed.length - before, 6);
  });

  it('other server execution routes reject local SQLite instead of invoking n8n or simulation', async () => {
    const count = observed.length;
    const normal = await runs.POST(
      request({ workflowId, message: '查询订单' }, '/api/runs'),
    );
    assert.equal(normal.status, 409);
    assert.equal(
      ((await normal.json()) as Json).errorCode,
      'LOCAL_DATABASE_BROWSER_REQUIRED',
    );
    const api = await publicRun.POST(
      request(
        { workflowId, message: '查询订单' },
        '/api/v1/run',
        'local-database-signing-test-token',
      ),
    );
    assert.equal(api.status, 409);
    assert.equal(
      ((await api.json()) as Json).errorCode,
      'LOCAL_DATABASE_BROWSER_REQUIRED',
    );
    assert.equal(observed.length, count);
  });

  it('keeps a valid third database round working past 120 seconds, blocks forged deadlines, and recovers real expiry', async () => {
    const {
      getOrCreateConsumerSession,
      upsertConsumerMessage,
      getConsumerMessage,
    } = await import('@/lib/server/consumer-store');
    const sessionRoute = await import('@/app/api/consumer/session/route');
    const { getActiveWorkflowVersion } =
      await import('@/lib/server/workflow-version-store');
    const { DATABASE_CHAT_SESSION_LIFETIME_MS } =
      await import('@/lib/server/database-agent');
    const version = await getActiveWorkflowVersion(workflowId);
    assert.ok(version);
    const body = bodyFor('lifecycle-key');
    const originalNow = Date.now;
    const startedAt = originalNow();
    let now = startedAt;
    Date.now = () => now;
    advanceModelClock = () => {
      now += 41_000;
    };
    try {
      const consumer = await getOrCreateConsumerSession(
        request(body),
        workflowId,
      );
      const cookie = consumer.setCookie!.split(';')[0];
      Object.assign(body, {
        consumerSessionId: consumer.session.id,
        sessionId: consumer.session.engineSessionId,
        agentMessageId: 'db_lifecycle_agent',
        userMessageId: 'db_lifecycle_user',
      });
      await upsertConsumerMessage(consumer.session, {
        id: 'db_lifecycle_user',
        role: 'user',
        status: 'completed',
        text: String(body.message),
        createdAt: now,
      });
      const savePending = async (metadata: Json) =>
        sessionRoute.POST(
          request(
            {
              workflowId,
              sessionId: consumer.session.id,
              messages: [
                {
                  id: 'db_lifecycle_agent',
                  role: 'agent',
                  status: 'working',
                  text: '',
                  metadata,
                  createdAt: startedAt,
                },
              ],
            },
            '/api/consumer/session',
            undefined,
            cookie,
          ),
        );
      const forged = {
        versionId: version.id,
        expiresAt: startedAt + 86_400_000,
      };
      assert.equal(
        (
          await savePending({
            chatRequestId: body.requestId,
            databaseChat: forged,
          })
        ).status,
        200,
      );
      assert.equal(
        Object.hasOwn(
          (await getConsumerMessage(consumer.session.id, 'db_lifecycle_agent'))!
            .metadata,
          'databaseChat',
        ),
        false,
      );
      const first = await chat.POST(
        request(body, undefined, undefined, cookie),
      );
      assert.equal(first.status, 200);
      const inspect = (await first.json()) as Pending;
      assert.equal(now - startedAt, 41_000);
      const initialProgress = (await getConsumerMessage(
        consumer.session.id,
        'db_lifecycle_agent',
      ))!.metadata.databaseChat;
      assert.deepEqual(initialProgress, {
        versionId: version.id,
        expiresAt: startedAt + DATABASE_CHAT_SESSION_LIFETIME_MS,
      });
      const count = observed.length;
      const restarted = await chat.POST(
        request(body, undefined, undefined, cookie),
      );
      assert.equal(restarted.status, 409);
      assert.equal(observed.length, count);
      assert.deepEqual(
        (await getConsumerMessage(consumer.session.id, 'db_lifecycle_agent'))!
          .metadata.databaseChat,
        initialProgress,
      );
      let next = await chat.POST(
        request(
          {
            ...body,
            databaseSession: inspect.database.session,
            databaseResults: schemaResult(inspect),
          },
          undefined,
          undefined,
          cookie,
        ),
      );
      assert.equal(next.status, 200);
      const query = (await next.json()) as Pending;
      assert.equal(now - startedAt, 82_000);
      next = await chat.POST(
        request(
          {
            ...body,
            databaseSession: query.database.session,
            databaseResults: queryResult(query),
          },
          undefined,
          undefined,
          cookie,
        ),
      );
      assert.equal(next.status, 200);
      const third = (await next.json()) as Pending;
      assert.equal(third.mode, 'local-database');
      assert.equal(third.database.requests[0].operation, 'query');
      assert.equal(now - startedAt, 123_000);
      const readRecovery = async () =>
        sessionRoute.GET(
          new Request(
            `http://urtoris.test/api/consumer/session?workflowId=${workflowId}&sessionId=${consumer.session.id}`,
            {
              headers: {
                Cookie: cookie,
                Origin: 'http://urtoris.test',
                'X-Real-IP': nextAddress(),
              },
            },
          ),
        );
      assert.equal((await readRecovery()).status, 200);
      assert.equal(
        (await getConsumerMessage(consumer.session.id, 'db_lifecycle_agent'))!
          .status,
        'working',
      );
      assert.equal(
        (
          await savePending({
            chatRequestId: body.requestId,
            databaseChat: forged,
          })
        ).status,
        200,
      );
      assert.deepEqual(
        (await getConsumerMessage(consumer.session.id, 'db_lifecycle_agent'))!
          .metadata.databaseChat,
        initialProgress,
      );
      assert.equal(
        (await savePending({ chatRequestId: body.requestId })).status,
        200,
      );
      assert.deepEqual(
        (await getConsumerMessage(consumer.session.id, 'db_lifecycle_agent'))!
          .metadata.databaseChat,
        initialProgress,
      );
      const beforeInvalid = await getConsumerMessage(
        consumer.session.id,
        'db_lifecycle_agent',
      );
      const invalid = await chat.POST(
        request(
          {
            ...body,
            databaseSession: third.database.session,
            databaseResults: [],
          },
          undefined,
          undefined,
          cookie,
        ),
      );
      assert.equal(invalid.status, 400);
      assert.equal(
        (await getConsumerMessage(consumer.session.id, 'db_lifecycle_agent'))!
          .updatedAt,
        beforeInvalid!.updatedAt,
      );
      now = startedAt + DATABASE_CHAT_SESSION_LIFETIME_MS + 1;
      const modelCount = observed.length;
      const expired = await chat.POST(
        request(
          {
            ...body,
            databaseSession: third.database.session,
            databaseResults: queryResult(third),
          },
          undefined,
          undefined,
          cookie,
        ),
      );
      assert.equal(expired.status, 403);
      assert.equal((await readRecovery()).status, 200);
      const recovered = await getConsumerMessage(
        consumer.session.id,
        'db_lifecycle_agent',
      );
      assert.equal(recovered?.status, 'failed');
      assert.match(recovered?.text ?? '', /重新发送/);
      assert.equal(observed.length, modelCount);
    } finally {
      advanceModelClock = undefined;
      Date.now = originalNow;
    }
  });

  it('Python and shell entrypoints reject the database workflow before executing their tools', async () => {
    const count = observed.length;
    const { createPythonTaskCapability } =
      await import('@/lib/server/python-task-capability');
    const pythonRoute = await import('@/app/api/python/agent/route');
    const shellRoute = await import('@/app/api/local-control/agent/route');
    env.PYTHON_AGENT_ENABLED = 'true';
    env.PYTHON_TASK_SIGNING_KEY = 'database-workflow-python-task-test-key';
    env.LOCAL_CONTROL_ENABLED = 'true';
    try {
      const capability = await createPythonTaskCapability();
      const python = await pythonRoute.POST(
        new Request('http://urtoris.test/api/python/agent', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'http://urtoris.test',
            'X-Urtoris-Task-Token': capability.taskToken,
          },
          body: JSON.stringify({
            ...bodyFor(),
            taskId: capability.taskId,
            agentMessageId: 'db_python_rejected',
          }),
        }),
      );
      assert.equal(python.status, 409);
      assert.equal(
        ((await python.json()) as Json).errorCode,
        'LOCAL_DATABASE_BROWSER_REQUIRED',
      );
      const shell = await shellRoute.POST(
        new Request('http://localhost:3000/api/local-control/agent', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'http://localhost:3000',
          },
          body: JSON.stringify({
            ...bodyFor(),
            agentMessageId: 'db_shell_rejected',
          }),
        }),
      );
      assert.equal(shell.status, 409);
      assert.equal(
        ((await shell.json()) as Json).errorCode,
        'LOCAL_DATABASE_BROWSER_REQUIRED',
      );
      assert.equal(observed.length, count);
    } finally {
      delete env.PYTHON_AGENT_ENABLED;
      delete env.PYTHON_TASK_SIGNING_KEY;
      delete env.LOCAL_CONTROL_ENABLED;
    }
  });

  it('rejects continuation after a new version replaces the authorized database snapshot', async () => {
    const body = bodyFor();
    const pending = await start(body);
    const count = observed.length;
    const { getWorkflowGraphDraft } =
      await import('@/lib/server/workflow-graph-store');
    const { publishWorkflowGraph } =
      await import('@/lib/server/workflow-version-store');
    const draft = await getWorkflowGraphDraft(workflowId);
    assert.ok(draft);
    await publishWorkflowGraph({
      workflowId,
      expectedRevision: draft.graph.revision,
    });
    const response = await continueWith(body, pending, schemaResult(pending));
    assert.equal(response.status, 403);
    assert.equal(
      ((await response.json()) as Json).errorCode,
      'LOCAL_DATABASE_SESSION_INVALID',
    );
    assert.equal(observed.length, count);
  });
});
