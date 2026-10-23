import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it, mock } from 'node:test';

import { installDatabaseMock, nextAddress, seedWorkflow } from './helpers/api';
import { resetEnv } from './helpers/cloudflare-workers-stub';
import { createTestDatabase, type TestDatabase } from './helpers/d1';

const database: TestDatabase = createTestDatabase();
installDatabaseMock(database.d1);

type AgentChatRoute = typeof import('@/app/api/agent/chat/route');
type PythonAgentRoute = typeof import('@/app/api/python/agent/route');
type LocalControlAgentRoute =
  typeof import('@/app/api/local-control/agent/route');
type PythonCapabilities = typeof import('@/lib/server/python-task-capability');
type ConsumerStore = typeof import('@/lib/server/consumer-store');
type SessionRoute = typeof import('@/app/api/consumer/session/route');

type JsonRecord = Record<string, unknown>;
type ProviderCall = { path: string; body: JsonRecord };

const DIRECT_WORKFLOW_ID = 'wf_memory_direct';
const N8N_WORKFLOW_ID = 'wf_memory_n8n';
const N8N_WEBHOOK_PATH = '/webhook/urtoris/memory';
const SHELL_STDOUT = `${'可见输出'.repeat(1200)}关键内容在输出末尾`;
const steps = [
  {
    id: 'step_compose',
    title: '生成回复',
    detail: '用模型或规则生成最终回复。',
    kind: 'compose',
  },
];

let route!: AgentChatRoute;
let pythonRoute!: PythonAgentRoute;
let shellRoute!: LocalControlAgentRoute;
let capabilities!: PythonCapabilities;
let store!: ConsumerStore;
let sessionRoute!: SessionRoute;
let mockServer!: ReturnType<typeof createServer>;
let serverOrigin = '';
let providerCalls: ProviderCall[] = [];

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function readRequest(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as JsonRecord) : {};
}

async function handleMockUpstream(
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (request.url === '/v1/info') {
    sendJson(response, 200, {
      protocol: 'urtoris.local-control.v1',
      mode: 'local-user-shell',
      username: 'test',
      uid: 501,
      hostname: 'test-mac',
      platform: 'darwin',
      shell: '/bin/zsh',
      default_cwd: '/tmp',
      concurrency: 1,
      maximum_timeout_seconds: 86_400,
      started_at: '2026-10-02T00:00:00.000Z',
    });
    return;
  }
  const body = await readRequest(request);
  providerCalls.push({ path: request.url ?? '', body });

  if (request.url === '/v1/runs') {
    sendJson(response, 200, {
      protocol: 'urtoris.local-control.v1',
      task_id: body.task_id,
      run_id: `shell_${'b'.repeat(32)}`,
      idempotency_key: body.idempotency_key,
      status: 'succeeded',
      command: body.command,
      cwd: '/tmp',
      shell: '/bin/zsh',
      timeout_seconds: 30,
      reason: '测试输出',
      pid: null,
      exit_code: 0,
      signal: null,
      stdout: SHELL_STDOUT,
      stderr: '',
      stdout_truncated: false,
      stderr_truncated: false,
      cancellation_requested: false,
      error: null,
      created_at: '2026-10-02T00:00:00.000Z',
      started_at: '2026-10-02T00:00:00.010Z',
      finished_at: '2026-10-02T00:00:00.020Z',
    });
    return;
  }

  if (body.model === 'mock-shell-execution') {
    const messages = body.messages as Array<{ role: string; content: string }>;
    if (!messages.some(({ role }) => role === 'tool')) {
      sendJson(response, 200, {
        model: body.model,
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_mock_shell',
                  type: 'function',
                  function: {
                    name: 'run_shell',
                    arguments: JSON.stringify({
                      protocol: 'urtoris.local-control.v1',
                      task_id: messages[0].content.match(
                        /localtask_[a-f0-9]{32}/,
                      )?.[0],
                      idempotency_key: 'mock-output',
                      command: 'printf mock',
                      reason: '测试输出',
                    }),
                  },
                },
              ],
            },
          },
        ],
      });
      return;
    }
  }

  if ((request.url ?? '').startsWith('/webhook/')) {
    sendJson(response, 200, {
      protocol: 'urtoris.v1',
      success: true,
      requestId: typeof body.requestId === 'string' ? body.requestId : 'x',
      engine: 'n8n',
      mode: 'llm',
      degraded: false,
      workflow:
        typeof body.workflowId === 'string' ? body.workflowId : N8N_WORKFLOW_ID,
      data: { message: 'n8n 侧回复。' },
      error: null,
      meta: { durationMs: 3, attempt: 1, httpStatus: 200 },
    });
    return;
  }

  sendJson(response, 200, {
    id: 'mock-completion',
    model: body.model ?? 'mock-model',
    choices: [
      {
        message: {
          role: 'assistant',
          content: '模拟回复\n结论 = 记忆已接通；优先级 = 中',
        },
      },
    ],
  });
}

async function createSessionWithHistory(
  workflowId: string,
  turns: Array<{
    role: 'user' | 'agent';
    text: string;
  }>,
): Promise<{ sessionId: string; cookie: string; messageIds: string[] }> {
  const resolved = await store.getOrCreateConsumerSession(
    new Request(
      `http://urtoris.test/api/consumer/session?workflowId=${workflowId}`,
    ),
    workflowId,
  );
  assert.ok(resolved.setCookie, '首次创建会话必须下发 cookie');
  // 消息 id 是主键，必须按会话区分，否则第二个会话的写入会被主键冲突静默挡掉。
  const prefix = resolved.session.id.slice(-12);
  const messageIds: string[] = [];
  const startedAt = Date.now() - turns.length - 1000;
  for (const [index, turn] of turns.entries()) {
    const id = `msg_${prefix}_${String(index).padStart(4, '0')}`;
    messageIds.push(id);
    await store.upsertConsumerMessage(resolved.session, {
      id,
      role: turn.role,
      status: 'completed',
      text: turn.text,
      createdAt: startedAt + index,
    });
  }
  return {
    sessionId: resolved.session.id,
    cookie: resolved.setCookie.split(';', 1)[0],
    messageIds,
  };
}

function postChat(
  body: JsonRecord,
  options: { cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Origin: 'http://urtoris.test',
    'X-Real-IP': nextAddress(),
  });
  if (options.cookie) headers.set('Cookie', options.cookie);
  return route.POST(
    new Request('http://urtoris.test/api/agent/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
}

function modelMessages(call: ProviderCall): Array<{
  role?: string;
  content?: string;
}> {
  const messages = call.body.messages;
  assert.ok(Array.isArray(messages), '模型请求必须带 messages');
  return messages as Array<{ role?: string; content?: string }>;
}

describe('POST /api/agent/chat · 会话记忆', () => {
  before(async () => {
    mockServer = createServer((request, response) => {
      void handleMockUpstream(request, response).catch((cause: unknown) => {
        sendJson(response, 500, {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      mockServer.once('error', reject);
      mockServer.listen(0, '127.0.0.1', () => resolve());
    });
    const address = mockServer.address() as AddressInfo;
    serverOrigin = `http://127.0.0.1:${address.port}`;
    resetEnv({
      N8N_BASE_URL: serverOrigin,
      N8N_WEBHOOK_TOKEN: 'test-n8n-token',
      PYTHON_AGENT_ENABLED: '1',
      PYTHON_TASK_SIGNING_KEY: 's'.repeat(48),
      PYTHON_EXECUTOR_URL: serverOrigin,
      PYTHON_EXECUTOR_TOKEN: 'p'.repeat(48),
      LOCAL_CONTROL_ENABLED: '1',
      LOCAL_CONTROL_URL: serverOrigin,
      LOCAL_CONTROL_TOKEN: 'l'.repeat(48),
    });
    await seedWorkflow(database.d1, {
      id: DIRECT_WORKFLOW_ID,
      name: '记忆直连模型',
      version: 1,
      publishedSteps: steps,
    });
    await seedWorkflow(database.d1, {
      id: N8N_WORKFLOW_ID,
      name: '记忆 n8n',
      version: 1,
      publishedSteps: steps,
      n8nWebhookUrl: `${serverOrigin}${N8N_WEBHOOK_PATH}`,
    });
    route = await import('@/app/api/agent/chat/route');
    store = await import('@/lib/server/consumer-store');
    pythonRoute = await import('@/app/api/python/agent/route');
    shellRoute = await import('@/app/api/local-control/agent/route');
    capabilities = await import('@/lib/server/python-task-capability');
    sessionRoute = await import('@/app/api/consumer/session/route');
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      mockServer.close((cause) => (cause ? reject(cause) : resolve()));
    });
    database.close();
  });

  it('直连模型和 n8n 都在返回 HTTP 回复前保存终态，重放不会重新调用模型', async () => {
    for (const workflowId of [DIRECT_WORKFLOW_ID, N8N_WORKFLOW_ID]) {
      const text = '沿用刚才的要求继续';
      const { sessionId, cookie, messageIds } = await createSessionWithHistory(
        workflowId,
        [
          { role: 'user', text: '请记住我需要中文结果' },
          { role: 'agent', text: '记住了。' },
          { role: 'user', text },
        ],
      );
      const session = await store.getConsumerSession(
        new Request('http://urtoris.test', { headers: { Cookie: cookie } }),
        workflowId,
        sessionId,
      );
      assert.ok(session);
      const agentMessageId = `agent_persist_${sessionId.slice(-16)}`;
      const requestId = `persist_${sessionId.slice(-20)}`;
      await store.upsertConsumerMessage(session, {
        id: agentMessageId,
        role: 'agent',
        status: 'working',
        text: '',
        metadata: { chatRequestId: requestId },
      });
      const input = {
        workflowId,
        message: text,
        consumerSessionId: sessionId,
        sessionId: session.engineSessionId,
        userMessageId: messageIds.at(-1),
        agentMessageId,
        requestId,
        apiKey: 'valid-memory-key',
        baseUrl: `${serverOrigin}/compatible-mode/v1`,
      };
      const response = await postChat(input, { cookie });
      assert.equal(response.status, 200);
      const saved = await store.getConsumerMessage(sessionId, agentMessageId);
      assert.equal(saved?.status, 'completed');
      assert.ok(saved?.text);
      assert.ok(saved?.metadata.runId);
      // The browser has not read or saved this response yet.
      const count = providerCalls.length;
      const replay = await postChat(input, { cookie });
      assert.equal(replay.status, 200);
      assert.equal(((await replay.json()) as JsonRecord).replayed, true);
      assert.equal(providerCalls.length, count);
    }
  });

  it('恢复丢失的 HTTP 回复时只读取已保存运行，不重新调用模型', async () => {
    const text = '恢复这条回复';
    const { sessionId, cookie, messageIds } = await createSessionWithHistory(
      DIRECT_WORKFLOW_ID,
      [{ role: 'user', text }],
    );
    const session = await store.getConsumerSession(
      new Request('http://urtoris.test', { headers: { Cookie: cookie } }),
      DIRECT_WORKFLOW_ID,
      sessionId,
    );
    assert.ok(session);
    const requestId = `recover_${sessionId.slice(-20)}`;
    const agentMessageId = `agent_recover_${sessionId.slice(-16)}`;
    await store.upsertConsumerMessage(session, {
      id: agentMessageId,
      role: 'agent',
      status: 'working',
      text: '',
      metadata: { chatRequestId: requestId },
    });
    // An older caller saved the run but never saved its chat message.
    const response = await postChat(
      {
        workflowId: DIRECT_WORKFLOW_ID,
        message: text,
        consumerSessionId: sessionId,
        sessionId: session.engineSessionId,
        userMessageId: messageIds[0],
        requestId,
        apiKey: 'valid-memory-key',
        baseUrl: `${serverOrigin}/compatible-mode/v1`,
      },
      { cookie },
    );
    const result = (await response.json()) as JsonRecord;
    const count = providerCalls.length;
    const restored = await sessionRoute.GET(
      new Request(
        `http://urtoris.test/api/consumer/session?workflowId=${DIRECT_WORKFLOW_ID}&sessionId=${sessionId}`,
        {
          headers: {
            Cookie: cookie,
            Origin: 'http://urtoris.test',
            'X-Real-IP': nextAddress(),
          },
        },
      ),
    );
    assert.equal(restored.status, 200);
    const data = (await restored.json()) as {
      messages: Array<{ id: string; status: string; text: string }>;
    };
    const reply = data.messages.find((m) => m.id === agentMessageId);
    assert.equal(reply?.status, 'completed');
    assert.equal(reply?.text, result.reply);
    assert.equal(providerCalls.length, count);
  });

  it('未完成且超过恢复期限的对话明确报错，不永久停在 working', async () => {
    const { sessionId, cookie } = await createSessionWithHistory(
      DIRECT_WORKFLOW_ID,
      [],
    );
    const session = await store.getConsumerSession(
      new Request('http://urtoris.test', { headers: { Cookie: cookie } }),
      DIRECT_WORKFLOW_ID,
      sessionId,
    );
    assert.ok(session);
    const agentMessageId = `agent_expired_${sessionId.slice(-16)}`;
    await store.upsertConsumerMessage(session, {
      id: agentMessageId,
      role: 'agent',
      status: 'working',
      text: '',
      metadata: { chatRequestId: `expired_${sessionId.slice(-20)}` },
      createdAt: Date.now() - 180_000,
    });
    const restored = await sessionRoute.GET(
      new Request(
        `http://urtoris.test/api/consumer/session?workflowId=${DIRECT_WORKFLOW_ID}&sessionId=${sessionId}`,
        {
          headers: {
            Cookie: cookie,
            Origin: 'http://urtoris.test',
            'X-Real-IP': nextAddress(),
          },
        },
      ),
    );
    assert.equal(restored.status, 200);
    const message = await store.getConsumerMessage(sessionId, agentMessageId);
    assert.equal(message?.status, 'failed');
    assert.match(message?.text ?? '', /重新发送/);
  });

  it('回复消息不能指向用户消息或别的对话，拒绝发生在模型调用前', async () => {
    const { sessionId, cookie, messageIds } = await createSessionWithHistory(
      DIRECT_WORKFLOW_ID,
      [{ role: 'user', text: '边界验证' }],
    );
    const count = providerCalls.length;
    for (const agentMessageId of [messageIds[0], 'agent_other_session']) {
      const response = await postChat(
        {
          workflowId: DIRECT_WORKFLOW_ID,
          message: '边界验证',
          consumerSessionId: sessionId,
          agentMessageId,
          apiKey: 'valid-memory-key',
          baseUrl: `${serverOrigin}/compatible-mode/v1`,
        },
        { cookie },
      );
      assert.equal(response.status, 409);
    }
    assert.equal(providerCalls.length, count);
  });

  it('直连模型：带上同一会话更早的轮次，且当前输入只出现一次', async () => {
    providerCalls = [];
    const { sessionId, cookie } = await createSessionWithHistory(
      DIRECT_WORKFLOW_ID,
      [
        { role: 'user', text: '先帮我把销售数据整理成表' },
        { role: 'agent', text: '已经整理成表，共 12 行。' },
        // 使用端在发请求前就把这一轮用户消息落库，历史里不能再重复一遍。
        { role: 'user', text: '把这份聊天记录写成 PDF' },
      ],
    );

    const response = await postChat(
      {
        workflowId: DIRECT_WORKFLOW_ID,
        message: '把这份聊天记录写成 PDF',
        consumerSessionId: sessionId,
        apiKey: 'valid-memory-key',
        baseUrl: `${serverOrigin}/compatible-mode/v1`,
      },
      { cookie },
    );
    const body = (await response.json()) as JsonRecord;

    assert.equal(response.status, 200);
    assert.equal(body.mode, 'model');
    const call = providerCalls.at(-1);
    assert.ok(call, '必须调用模型');
    const messages = modelMessages(call);
    assert.equal(messages[0]?.role, 'system');
    assert.deepEqual(
      messages.slice(1).map((entry) => [entry.role, entry.content]),
      [
        ['user', '先帮我把销售数据整理成表'],
        ['assistant', '已经整理成表，共 12 行。'],
        ['user', '把这份聊天记录写成 PDF'],
      ],
    );
  });

  it('没有会话编号时按无上下文处理，不凭空补历史', async () => {
    providerCalls = [];
    const response = await postChat({
      workflowId: DIRECT_WORKFLOW_ID,
      message: '这个聊天框里的所有的记录',
      apiKey: 'valid-memory-key-2',
      baseUrl: `${serverOrigin}/compatible-mode/v1`,
    });

    assert.equal(response.status, 200);
    const call = providerCalls.at(-1);
    assert.ok(call, '必须调用模型');
    const messages = modelMessages(call);
    assert.equal(messages.length, 2);
    assert.match(messages[0]?.content ?? '', /本次没有更早的对话记录/);
    assert.equal(messages[1]?.content, '这个聊天框里的所有的记录');
  });

  it('n8n 引擎：信封 context 里带上已落库的历史轮次', async () => {
    providerCalls = [];
    const { sessionId, cookie } = await createSessionWithHistory(
      N8N_WORKFLOW_ID,
      [
        { role: 'user', text: '第一轮问题' },
        { role: 'agent', text: '第一轮回答' },
      ],
    );

    const response = await postChat(
      {
        workflowId: N8N_WORKFLOW_ID,
        message: '第二轮问题',
        consumerSessionId: sessionId,
        requestId: 'req_memory_n8n_001',
      },
      { cookie },
    );

    assert.equal(response.status, 200);
    const call = providerCalls.at(-1);
    assert.equal(call?.path, N8N_WEBHOOK_PATH);
    // n8n 的提示词节点只读 message：历史必须拼在这里，否则那一侧仍然失忆。
    const composed = call?.body.message;
    assert.equal(typeof composed, 'string');
    assert.match(composed as string, /^【同一会话更早的对话记录】/);
    assert.match(composed as string, /用户：第一轮问题/);
    assert.match(composed as string, /助手：第一轮回答/);
    assert.match(composed as string, /【当前消息】\n第二轮问题$/);
    const context = call?.body.context as JsonRecord | undefined;
    assert.equal(context?.currentMessage, '第二轮问题');
    assert.deepEqual(context?.conversationHistory, [
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
    ]);
  });

  it('n8n 引擎：没有更早轮次时 message 保持用户原话', async () => {
    providerCalls = [];
    const { sessionId, cookie } = await createSessionWithHistory(
      N8N_WORKFLOW_ID,
      [],
    );

    const response = await postChat(
      {
        workflowId: N8N_WORKFLOW_ID,
        message: '第二句',
        consumerSessionId: sessionId,
        requestId: 'req_memory_n8n_002',
      },
      { cookie },
    );

    assert.equal(response.status, 200);
    const call = providerCalls.at(-1);
    assert.equal(call?.body.message, '第二句');
    const context = call?.body.context as JsonRecord | undefined;
    assert.equal(context?.currentMessage, '第二句');
    assert.equal(context?.conversationHistory, undefined);
  });

  it('直连模型读取超过 200 条消息，长正文和最早、最新轮次全部保留', async () => {
    providerCalls = [];
    const turns = Array.from({ length: 251 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('agent' as const),
      text:
        index === 0
          ? `开头${'完整正文'.repeat(3000)}关键结论在末尾`
          : `第 ${index} 条${'正文'.repeat(40)}`,
    }));
    const { sessionId, cookie, messageIds } = await createSessionWithHistory(
      DIRECT_WORKFLOW_ID,
      turns,
    );
    const response = await postChat(
      {
        workflowId: DIRECT_WORKFLOW_ID,
        message: turns.at(-1)!.text,
        consumerSessionId: sessionId,
        userMessageId: messageIds.at(-1),
        apiKey: 'valid-memory-key',
        baseUrl: `${serverOrigin}/compatible-mode/v1`,
      },
      { cookie },
    );
    assert.equal(response.status, 200);
    const messages = modelMessages(providerCalls.at(-1)!);
    assert.deepEqual(
      messages.slice(1).map(({ content }) => content),
      turns.map(({ text }) => text),
    );
    assert.equal(messages.length, turns.length + 1);
  });

  it('n8n 的 message 和结构化 context 都包含完整长历史', async () => {
    providerCalls = [];
    const turns = Array.from({ length: 35 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('agent' as const),
      text: `第 ${index} 条${'详细正文'.repeat(400)}末尾`,
    }));
    const { sessionId, cookie } = await createSessionWithHistory(
      N8N_WORKFLOW_ID,
      turns,
    );
    const response = await postChat(
      {
        workflowId: N8N_WORKFLOW_ID,
        message: '总结整个聊天框',
        consumerSessionId: sessionId,
        requestId: 'req_memory_full_n8n',
      },
      { cookie },
    );
    assert.equal(response.status, 200);
    const call = providerCalls.at(-1)!;
    const context = call.body.context as {
      conversationHistory: Array<{ content: string }>;
    };
    assert.deepEqual(
      context.conversationHistory.map(({ content }) => content),
      turns.map(({ text }) => text),
    );
    for (const turn of turns)
      assert.ok((call.body.message as string).includes(turn.text));
  });

  it('按当前消息编号去重时，更早的同文消息仍完整保留', async () => {
    providerCalls = [];
    const { sessionId, cookie, messageIds } = await createSessionWithHistory(
      DIRECT_WORKFLOW_ID,
      [
        { role: 'user', text: '再试一次' },
        { role: 'user', text: '再试一次' },
      ],
    );
    const response = await postChat(
      {
        workflowId: DIRECT_WORKFLOW_ID,
        message: '再试一次',
        consumerSessionId: sessionId,
        userMessageId: messageIds[1],
        apiKey: 'valid-memory-key',
        baseUrl: `${serverOrigin}/compatible-mode/v1`,
      },
      { cookie },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      modelMessages(providerCalls.at(-1)!)
        .slice(1)
        .map(({ content }) => content),
      ['再试一次', '再试一次'],
    );
  });

  it('浏览器和工作流之间的历史隔离，未保存的当前消息也不会启动模型', async () => {
    const own = await createSessionWithHistory(DIRECT_WORKFLOW_ID, [
      { role: 'user', text: '我的内容' },
    ]);
    const other = await createSessionWithHistory(DIRECT_WORKFLOW_ID, [
      { role: 'user', text: '另一浏览器的内容' },
    ]);
    for (const [workflowId, cookie, userMessageId, expectedStatus] of [
      [DIRECT_WORKFLOW_ID, other.cookie, undefined, 404],
      [N8N_WORKFLOW_ID, own.cookie, undefined, 404],
      [DIRECT_WORKFLOW_ID, own.cookie, 'msg_missing', 409],
    ] as const) {
      providerCalls = [];
      const response = await postChat(
        {
          workflowId,
          message: '我的内容',
          consumerSessionId: own.sessionId,
          userMessageId,
          apiKey: 'valid-memory-key',
          baseUrl: `${serverOrigin}/compatible-mode/v1`,
        },
        { cookie },
      );
      assert.equal(response.status, expectedStatus);
      assert.equal(providerCalls.length, 0);
    }
  });

  it('历史分页中途失败时明确报错，不向模型发送部分历史', async () => {
    const { sessionId, cookie } = await createSessionWithHistory(
      DIRECT_WORKFLOW_ID,
      Array.from({ length: 30 }, (_, index) => ({
        role: 'user' as const,
        text: `问题 ${index}`,
      })),
    );
    const originalPrepare = database.d1.prepare.bind(database.d1);
    const readFailure = mock.method(database.d1, 'prepare', (sql: string) => {
      if (
        sql.includes('FROM consumer_messages') &&
        sql.includes('created_at >')
      )
        throw new Error('database unavailable');
      return originalPrepare(sql);
    });
    providerCalls = [];
    try {
      const response = await postChat(
        {
          workflowId: DIRECT_WORKFLOW_ID,
          message: '总结历史',
          consumerSessionId: sessionId,
          apiKey: 'valid-memory-key',
          baseUrl: `${serverOrigin}/compatible-mode/v1`,
        },
        { cookie },
      );
      assert.equal(response.status, 503);
      assert.match(
        ((await response.json()) as { error: string }).error,
        /无法读取完整聊天记录/,
      );
      assert.equal(providerCalls.length, 0);
    } finally {
      readFailure.mock.restore();
    }
  });

  for (const mode of ['python', 'shell'] as const) {
    it(`${mode} 模式收到同一聊天框的完整记录和当前消息`, async () => {
      providerCalls = [];
      const turns = Array.from({ length: 31 }, (_, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('agent' as const),
        text:
          index === 0 ? `第一条${'内容'.repeat(2000)}末尾` : `问题 ${index}`,
      }));
      const { sessionId, cookie, messageIds } = await createSessionWithHistory(
        DIRECT_WORKFLOW_ID,
        turns,
      );
      const capability = await capabilities.createPythonTaskCapability();
      const path =
        mode === 'python' ? '/api/python/agent' : '/api/local-control/agent';
      const request = new Request(`http://localhost:3000${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:3000',
          Cookie: cookie,
          'X-Real-IP': nextAddress(),
          'X-Urtoris-Task-Token': capability.taskToken,
        },
        body: JSON.stringify({
          workflowId: DIRECT_WORKFLOW_ID,
          sessionId,
          userMessageId: messageIds.at(-1),
          agentMessageId: `agent_${mode}_${sessionId.slice(-12)}`,
          taskId: capability.taskId,
          message: turns.at(-1)!.text,
          apiKey: 'valid-memory-key',
          baseUrl: `${serverOrigin}/compatible-mode/v1`,
        }),
      });
      const response = await (
        mode === 'python' ? pythonRoute : shellRoute
      ).POST(request);
      assert.equal(response.status, 200, JSON.stringify(await response.json()));
      const messages = modelMessages(providerCalls.at(-1)!);
      assert.deepEqual(
        messages.slice(1).map(({ content }) => content),
        turns.map(({ text }) => text),
      );
      assert.equal(messages.filter(({ role }) => role === 'tool').length, 0);
    });
  }

  it('聊天框里的完整 Shell 输出原样保存，并传给下一轮模型', async () => {
    const { sessionId, cookie, messageIds } = await createSessionWithHistory(
      DIRECT_WORKFLOW_ID,
      [{ role: 'user', text: '检查输出' }],
    );
    const response = await shellRoute.POST(
      new Request('http://localhost:3000/api/local-control/agent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:3000',
          Cookie: cookie,
          'X-Real-IP': nextAddress(),
        },
        body: JSON.stringify({
          workflowId: DIRECT_WORKFLOW_ID,
          sessionId,
          userMessageId: messageIds[0],
          agentMessageId: `agent_output_${sessionId.slice(-12)}`,
          message: '检查输出',
          apiKey: 'valid-memory-key',
          model: 'mock-shell-execution',
          baseUrl: `${serverOrigin}/compatible-mode/v1`,
        }),
      }),
    );
    const body = (await response.json()) as {
      succeeded: boolean;
      runs: Array<{ stdout: string }>;
    };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.succeeded, true);
    assert.equal(body.runs[0].stdout, SHELL_STDOUT);

    providerCalls = [];
    const followup = await postChat(
      {
        workflowId: DIRECT_WORKFLOW_ID,
        consumerSessionId: sessionId,
        message: '查看刚才输出的最后一行',
        apiKey: 'valid-memory-key',
        baseUrl: `${serverOrigin}/compatible-mode/v1`,
      },
      { cookie },
    );
    assert.equal(followup.status, 200);
    const assistant = modelMessages(providerCalls.at(-1)!).find(
      ({ role }) => role === 'assistant',
    );
    const metadata = JSON.parse(
      assistant!.content!.split('【聊天框附加信息（历史记录）】\n')[1],
    );
    assert.equal(metadata.shell.runs[0].stdout, SHELL_STDOUT);
  });
});
