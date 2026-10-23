import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { PythonRunObservation } from '@/lib/server/python-agent';
import { installDatabaseMock, nextAddress, seedWorkflow } from './helpers/api';
import { createTestDatabase, type TestDatabase } from './helpers/d1';

const database: TestDatabase = createTestDatabase();
installDatabaseMock(database.d1);

const WORKFLOW_ID = 'wf_consumer_persist';
const steps = [
  {
    id: 'step_output',
    title: '输出结果',
    detail: '返回结果。',
    kind: 'output',
  },
];

type SessionRoute = typeof import('@/app/api/consumer/session/route');
type ConsumerStore = typeof import('@/lib/server/consumer-store');

let route!: SessionRoute;
let store!: ConsumerStore;

function request(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  options: {
    cookie?: string;
    body?: unknown;
    marker?: boolean;
    sessionId?: string;
  } = {},
) {
  const headers = new Headers({
    Origin: 'http://localhost:3000',
    'X-Real-IP': nextAddress(),
  });
  if (options.marker) {
    headers.delete('Origin');
    headers.set('X-Urtoris-Consumer-Client', '1');
  }
  if (options.cookie) headers.set('Cookie', options.cookie);
  if (options.body !== undefined)
    headers.set('Content-Type', 'application/json');
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const query = new URLSearchParams({ workflowId: WORKFLOW_ID });
  if (options.sessionId) query.set('sessionId', options.sessionId);
  return new Request(
    `http://localhost:3000/api/consumer/session?${query.toString()}`,
    init,
  );
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('Set-Cookie') ?? '';
  const pair = header.split(';', 1)[0];
  assert.match(pair, /^urtoris_consumer=v1\.[a-f0-9]{64}$/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  return pair;
}

const queuedObservation: PythonRunObservation = {
  runId: `run_${'1'.repeat(32)}`,
  attempt: 1,
  profile: 'long',
  status: 'queued',
  exitCode: null,
  stdout: null,
  stderr: null,
  stdoutTruncated: false,
  stderrTruncated: false,
  cleanupStatus: 'pending',
  createdAt: '2026-09-15T01:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  artifacts: [],
  error: null,
  metrics: {
    queuedMs: null,
    durationMs: null,
    cpuTimeMs: null,
    peakMemoryBytes: null,
  },
  limits: {
    timeoutSeconds: 600,
    cpuCount: 2,
    memoryBytes: 2 * 1024 * 1024 * 1024,
    processes: 64,
    stdoutBytes: 1024 * 1024,
    stderrBytes: 1024 * 1024,
  },
};

describe('使用端会话持久化', () => {
  before(async () => {
    await seedWorkflow(database.d1, {
      id: WORKFLOW_ID,
      publishedSteps: steps,
      version: 1,
    });
    route = await import('@/app/api/consumer/session/route');
    store = await import('@/lib/server/consumer-store');
  });

  after(() => database.close());

  it('刷新和重开仍恢复同一会话与消息，不同浏览器相互隔离', async () => {
    const messageStartedAt = Date.now() - 1_000;
    const first = await route.GET(request('GET'));
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as {
      session: { id: string; engineSessionId: string };
      messages: unknown[];
    };
    const cookie = cookieFrom(first);
    assert.equal(firstBody.session.id, firstBody.session.engineSessionId);
    assert.deepEqual(firstBody.messages, []);

    const saved = await route.POST(
      request('POST', {
        cookie,
        body: {
          workflowId: WORKFLOW_ID,
          messages: [
            {
              id: 'msg_user_001',
              role: 'user',
              status: 'completed',
              text: '请求生成报表',
              metadata: { mode: 'llm' },
              createdAt: messageStartedAt,
            },
            {
              id: 'msg_agent_001',
              role: 'agent',
              status: 'working',
              text: '',
              metadata: { pythonTaskId: `task_${'2'.repeat(32)}` },
              createdAt: messageStartedAt + 1,
            },
          ],
        },
      }),
    );
    assert.equal(saved.status, 200);

    const reopened = await route.GET(request('GET', { cookie }));
    const reopenedBody = (await reopened.json()) as {
      session: { id: string };
      messages: Array<{ id: string; status: string; text: string }>;
    };
    assert.equal(reopenedBody.session.id, firstBody.session.id);
    assert.deepEqual(
      reopenedBody.messages.map(({ id, status, text }) => ({
        id,
        status,
        text,
      })),
      [
        { id: 'msg_user_001', status: 'completed', text: '请求生成报表' },
        { id: 'msg_agent_001', status: 'working', text: '' },
      ],
    );

    const otherBrowser = await route.GET(request('GET'));
    const otherBody = (await otherBrowser.json()) as {
      session: { id: string };
      messages: unknown[];
    };
    assert.notEqual(otherBody.session.id, firstBody.session.id);
    assert.deepEqual(otherBody.messages, []);
  });

  it('运行台账落 D1，并只授权原浏览器取消或下载', async () => {
    const first = await route.GET(request('GET'));
    const body = (await first.json()) as { session: { id: string } };
    const cookie = cookieFrom(first);
    const session = await store.getConsumerSession(
      request('GET', { cookie }),
      WORKFLOW_ID,
    );
    assert.equal(session?.id, body.session.id);
    assert.ok(session);

    const taskId = `task_${'2'.repeat(32)}`;
    await store.upsertConsumerMessage(session, {
      id: 'msg_agent_run_001',
      role: 'agent',
      status: 'working',
      text: '',
    });
    await store.upsertConsumerPythonRun(
      session,
      taskId,
      'msg_agent_run_001',
      queuedObservation,
    );

    const runs = await store.listConsumerPythonRuns(session.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.profile, 'long');
    assert.equal(runs[0]?.status, 'queued');
    assert.equal(runs[0]?.limits.timeoutSeconds, 600);
    assert.equal(
      await store.consumerOwnsPythonRun(
        request('GET', { cookie }),
        taskId,
        queuedObservation.runId,
      ),
      true,
    );
    assert.equal(
      await store.consumerOwnsPythonRun(
        request('GET'),
        taskId,
        queuedObservation.runId,
      ),
      false,
    );
  });

  it('新建多段对话、按会话恢复，并自动生成首轮标题', async () => {
    const first = await route.GET(request('GET'));
    const firstBody = (await first.json()) as {
      session: { id: string };
      conversations: Array<{ id: string; title: string }>;
    };
    const cookie = cookieFrom(first);

    const created = await route.PUT(
      request('PUT', {
        cookie,
        body: { workflowId: WORKFLOW_ID },
      }),
    );
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as {
      session: { id: string; title: string };
      conversations: Array<{ id: string; title: string }>;
    };
    assert.notEqual(createdBody.session.id, firstBody.session.id);
    assert.equal(createdBody.session.title, '新对话');
    assert.equal(createdBody.conversations.length, 2);

    const saved = await route.POST(
      request('POST', {
        cookie,
        body: {
          workflowId: WORKFLOW_ID,
          sessionId: createdBody.session.id,
          messages: [
            {
              id: 'msg_trip_user_001',
              role: 'user',
              status: 'completed',
              text: '帮我制定一份首尔三日旅行计划',
              metadata: {},
            },
          ],
        },
      }),
    );
    assert.equal(saved.status, 200);

    const titled = await route.PATCH(
      request('PATCH', {
        cookie,
        body: {
          workflowId: WORKFLOW_ID,
          sessionId: createdBody.session.id,
          userMessage: '帮我制定一份首尔三日旅行计划',
          agentReply: '可以，我会按区域规划每天的路线。',
        },
      }),
    );
    assert.equal(titled.status, 200);
    const titledBody = (await titled.json()) as {
      session: { id: string; title: string };
      conversations: Array<{ id: string; title: string }>;
    };
    assert.equal(titledBody.session.title, '帮我制定一份首尔三日旅行计划');
    assert.equal(titledBody.conversations[0]?.id, createdBody.session.id);

    const reopened = await route.GET(
      request('GET', {
        cookie,
        sessionId: createdBody.session.id,
      }),
    );
    const reopenedBody = (await reopened.json()) as {
      session: { id: string; title: string };
      messages: Array<{ id: string; text: string }>;
    };
    assert.equal(reopenedBody.session.id, createdBody.session.id);
    assert.equal(reopenedBody.session.title, titledBody.session.title);
    assert.deepEqual(
      reopenedBody.messages.map(({ id, text }) => ({ id, text })),
      [
        {
          id: 'msg_trip_user_001',
          text: '帮我制定一份首尔三日旅行计划',
        },
      ],
    );
  });

  it('拒绝伪造的消息角色', async () => {
    const first = await route.GET(request('GET'));
    const cookie = cookieFrom(first);
    const response = await route.POST(
      request('POST', {
        cookie,
        body: {
          workflowId: WORKFLOW_ID,
          messages: [
            {
              id: 'msg_invalid_role',
              role: 'administrator',
              status: 'completed',
              text: '不应写入',
              metadata: {},
            },
          ],
        },
      }),
    );
    assert.equal(response.status, 400);
  });

  it('嵌入式同源 GET 缺少 Origin 时可用专用客户端标记', async () => {
    const response = await route.GET(request('GET', { marker: true }));
    assert.equal(response.status, 200);
  });

  it('跨站请求即使携带客户端标记也仍被拒绝', async () => {
    const response = await route.GET(
      new Request(
        `http://localhost:3000/api/consumer/session?workflowId=${WORKFLOW_ID}`,
        {
          headers: {
            Origin: 'https://evil.example',
            'Sec-Fetch-Site': 'cross-site',
            'X-Urtoris-Consumer-Client': '1',
            'X-Real-IP': nextAddress(),
          },
        },
      ),
    );
    assert.equal(response.status, 403);
  });
});
