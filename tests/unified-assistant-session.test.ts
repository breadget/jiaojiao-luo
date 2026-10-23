import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { UNIFIED_ASSISTANT_WORKFLOW_ID } from '@/lib/assistant-identity';
import { installDatabaseMock, nextAddress, seedWorkflow } from './helpers/api';
import { createTestDatabase } from './helpers/d1';

const database = createTestDatabase();
installDatabaseMock(database.d1);
let route: typeof import('@/app/api/consumer/session/route');
let workflowStore: typeof import('@/lib/server/workflow-store');

function request(
  method: string,
  options: {
    cookie?: string;
    body?: object;
    sessionId?: string;
    workflowId?: string;
  } = {},
) {
  const query = new URLSearchParams({ assistantMode: 'unified' });
  if (options.sessionId) query.set('sessionId', options.sessionId);
  if (options.workflowId) query.set('workflowId', options.workflowId);
  return new Request(`http://localhost:3000/api/consumer/session?${query}`, {
    method,
    headers: {
      Origin: 'http://localhost:3000',
      'X-Real-IP': nextAddress(),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body
      ? { body: JSON.stringify({ ...options.body, assistantMode: 'unified' }) }
      : {}),
  });
}

describe('统一智能体会话', () => {
  before(async () => {
    route = await import('@/app/api/consumer/session/route');
    workflowStore = await import('@/lib/server/workflow-store');
  });
  after(() => database.close());

  it('没有已发布工作流也能创建，内部对话分区不会出现在工作流列表', async () => {
    const response = await route.GET(request('GET'));
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      session: { workflowId: string };
      messages: unknown[];
    };
    assert.equal(body.session.workflowId, UNIFIED_ASSISTANT_WORKFLOW_ID);
    assert.deepEqual(body.messages, []);
    assert.deepEqual(await workflowStore.listWorkflows(), []);
    assert.equal(
      await workflowStore.getWorkflowById(UNIFIED_ASSISTANT_WORKFLOW_ID),
      null,
    );
    assert.equal(
      database.raw.prepare('SELECT COUNT(*) AS n FROM workflows').get()?.n,
      1,
    );
    const again = await route.GET(request('GET'));
    assert.equal(again.status, 200);
    assert.equal(
      database.raw.prepare('SELECT COUNT(*) AS n FROM workflows').get()?.n,
      1,
    );
  });

  it('切换工具仍保留同一浏览器的会话、历史和来源，其他浏览器无法读取', async () => {
    const first = await route.GET(request('GET', { workflowId: 'wf_first' }));
    const cookie = first.headers.get('Set-Cookie')!.split(';', 1)[0];
    const firstBody = (await first.json()) as { session: { id: string } };
    const saved = await route.POST(
      request('POST', {
        cookie,
        body: {
          workflowId: 'wf_second',
          sessionId: firstBody.session.id,
          messages: [
            {
              id: 'unified_course_answer',
              role: 'agent',
              status: 'completed',
              text: '原文依据',
              metadata: { knowledge: { mode: 'retrieval_only', sources: [] } },
            },
          ],
        },
      }),
    );
    assert.equal(saved.status, 200);
    const reopened = await route.GET(
      request('GET', {
        cookie,
        sessionId: firstBody.session.id,
        workflowId: 'wf_third',
      }),
    );
    const body = (await reopened.json()) as {
      session: { id: string };
      messages: Array<{ text: string; metadata: object }>;
    };
    assert.equal(body.session.id, firstBody.session.id);
    assert.equal(body.messages[0].text, '原文依据');
    assert.deepEqual(body.messages[0].metadata, {
      knowledge: { mode: 'retrieval_only', sources: [] },
    });
    const denied = await route.GET(
      request('GET', { sessionId: firstBody.session.id }),
    );
    assert.equal(denied.status, 404);
  });

  it('新建与命名不依赖工具，旧工作流对话和统一对话列表分别可恢复', async () => {
    const created = await route.PUT(request('PUT', { body: {} }));
    assert.equal(created.status, 201);
    const cookie = created.headers.get('Set-Cookie')!.split(';', 1)[0];
    const body = (await created.json()) as {
      session: { id: string };
      conversations: Array<{ workflowId: string }>;
    };
    const titled = await route.PATCH(
      request('PATCH', {
        cookie,
        body: { sessionId: body.session.id, userMessage: '队列的先进先出原则' },
      }),
    );
    assert.equal(titled.status, 200);
    const named = (await titled.json()) as { session: { title: string } };
    assert.equal(named.session.title, '队列的先进先出原则');
    await seedWorkflow(database.d1, { id: 'wf_legacy', publishedSteps: [] });
    const legacyRequest = new Request(
      'http://localhost:3000/api/consumer/session?workflowId=wf_legacy',
      {
        headers: {
          Origin: 'http://localhost:3000',
          Cookie: cookie,
          'X-Real-IP': nextAddress(),
        },
      },
    );
    const legacy = await route.GET(legacyRequest);
    assert.equal(legacy.status, 200);
    const legacyBody = (await legacy.json()) as {
      conversations: Array<{ workflowId: string }>;
    };
    assert.deepEqual(
      legacyBody.conversations.map((item) => item.workflowId),
      ['wf_legacy'],
    );
    const reopened = await route.GET(request('GET', { cookie }));
    const current = (await reopened.json()) as {
      conversations: Array<{ workflowId: string }>;
    };
    assert.deepEqual(
      current.conversations.map((item) => item.workflowId),
      [UNIFIED_ASSISTANT_WORKFLOW_ID],
    );
  });
});
