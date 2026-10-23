import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it, mock } from 'node:test';
import { UNIFIED_ASSISTANT_WORKFLOW_ID } from '@/lib/assistant-identity';
import { installDatabaseMock, nextAddress, seedWorkflow } from './helpers/api';
import { createTestDatabase } from './helpers/d1';
import { chainGraph, makeEdge, makeNode } from './helpers/graph';
import { resetEnv } from './helpers/cloudflare-workers-stub';

type PythonOptions = Parameters<typeof import('@/lib/server/python-agent-runtime').runPythonAgent>[0];
type ShellOptions = Parameters<typeof import('@/lib/server/local-control-agent-runtime').runLocalControlAgent>[0];
type ToolOptions = PythonOptions | ShellOptions;

const database = createTestDatabase();
installDatabaseMock(database.d1);
const calls: ToolOptions[] = [];
const pythonRuntime = {
  isPythonAgentEnabled: () => true,
  runPythonAgent: async (input: PythonOptions) => {
    calls.push(input);
    return {
      reply: '已完成文件任务。', replySource: 'model', attempts: 0,
      usedPython: false, succeeded: true, stopReason: 'completed',
      runs: [], artifacts: [], model: 'qwen-plus',
    };
  },
};
const shellRuntime = {
  runLocalControlAgent: async (input: ShellOptions) => {
    calls.push(input);
    return {
      reply: '已完成命令任务。', replySource: 'model', commands: 0,
      usedShell: false, succeeded: true, stopReason: 'completed',
      runs: [], model: 'qwen-plus',
    };
  },
};
mock.module('@/lib/server/python-agent-runtime', {
  exports: pythonRuntime,
} as unknown as Parameters<typeof mock.module>[1]);
mock.module('@/lib/server/local-control-agent-runtime', {
  exports: shellRuntime,
} as unknown as Parameters<typeof mock.module>[1]);

let pythonRoute: typeof import('@/app/api/python/agent/route');
let shellRoute: typeof import('@/app/api/local-control/agent/route');
let store: typeof import('@/lib/server/consumer-store');
let capability: typeof import('@/lib/server/python-task-capability');
const workflowIds = ['wf_unified_tool_a', 'wf_unified_tool_b'];
const constraints = ['只允许读取数据，不得修改数据。', '不得泄露报告中的个人隐私。'];
const steps = [{ id: 'compose', title: '回复', detail: '回复用户。', kind: 'compose' }];

before(async () => {
  resetEnv({ LOCAL_CONTROL_ENABLED: '1', PYTHON_TASK_SIGNING_KEY: 's'.repeat(48) });
  const { saveWorkflowGraphDraft } = await import('@/lib/server/workflow-graph-store');
  const { publishWorkflowGraph } = await import('@/lib/server/workflow-version-store');
  for (const [index, workflowId] of workflowIds.entries()) {
    await seedWorkflow(database.d1, { id: workflowId, publishedSteps: steps, version: 1 });
    const graph = chainGraph(['trigger', 'aiAgent', 'output'], workflowId);
    graph.nodes[1].config.constraints = constraints[index];
    graph.nodes.push(makeNode('llmModel', 'model'));
    graph.edges.push(makeEdge(graph.nodes[1].id, 'resource.model', 'model', 'model.provider', 'model'));
    const saved = await saveWorkflowGraphDraft({ workflowId, graph, expectedRevision: 0 });
    await publishWorkflowGraph({ workflowId, expectedRevision: saved.graph.revision });
  }
  pythonRoute = await import('@/app/api/python/agent/route');
  shellRoute = await import('@/app/api/local-control/agent/route');
  store = await import('@/lib/server/consumer-store');
  capability = await import('@/lib/server/python-task-capability');
});

afterEach(() => { calls.length = 0; });
after(() => { database.close(); resetEnv(); });

async function newSession(workflowId = UNIFIED_ASSISTANT_WORKFLOW_ID) {
  if (workflowId === UNIFIED_ASSISTANT_WORKFLOW_ID) {
    const { ensureUnifiedAssistantWorkflow } = await import('@/lib/server/assistant-session');
    await ensureUnifiedAssistantWorkflow();
  }
  const resolved = await store.getOrCreateConsumerSession(new Request('http://localhost:3000'), workflowId);
  assert.ok(resolved.setCookie);
  return { session: resolved.session, cookie: resolved.setCookie.split(';')[0] };
}

async function requestTool(
  mode: 'python' | 'shell', body: Record<string, unknown>, cookie?: string,
) {
  const task = await capability.createPythonTaskCapability();
  const path = mode === 'python' ? '/api/python/agent' : '/api/local-control/agent';
  return (mode === 'python' ? pythonRoute : shellRoute).POST(new Request(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Origin: 'http://localhost:3000',
      'X-Real-IP': nextAddress(), 'X-Urtoris-Task-Token': task.taskToken,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ taskId: task.taskId, message: '处理当前任务', ...body }),
  }));
}

describe('unified assistant Python and Shell conversation partition', () => {
  it('creates the hidden anchor safely on the first selected-workflow tool call', async () => {
    const response = await requestTool('python', {
      assistantMode: 'unified', workflowId: workflowIds[0], agentMessageId: 'first_unified_tool',
    });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    const cookie = response.headers.get('Set-Cookie')?.split(';')[0];
    assert.ok(cookie);
    const session = await store.getConsumerSession(
      new Request('http://localhost:3000', { headers: { Cookie: cookie } }),
      UNIFIED_ASSISTANT_WORKFLOW_ID,
    );
    assert.ok(session);
    assert.equal((await store.getConsumerMessage(session.id, 'first_unified_tool'))?.status, 'completed');
  });

  for (const mode of ['python', 'shell'] as const) {
    it(`${mode} keeps one anchor session while reading each selected workflow's published constraints`, async () => {
      const { session, cookie } = await newSession();
      await store.upsertConsumerMessage(session, {
        id: `earlier_${mode}_${session.id.slice(-10)}`, role: 'user', status: 'completed',
        text: '课程原文中队列使用先进先出。', createdAt: Date.now() - 1000,
      });
      for (const [index, workflowId] of workflowIds.entries()) {
        const userMessageId = `user_${mode}_${index}_${session.id.slice(-10)}`;
        const agentMessageId = `agent_${mode}_${index}_${session.id.slice(-10)}`;
        const text = `根据前文处理任务 ${index}`;
        await store.upsertConsumerMessage(session, {
          id: userMessageId, role: 'user', status: 'completed', text,
        });
        const response = await requestTool(mode, {
          workflowId, assistantMode: 'unified', sessionId: session.id,
          userMessageId, agentMessageId, message: text,
          apiKey: 'shared-transient-test-key', provider: 'qwen',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus',
        }, cookie);
        assert.equal(response.status, 200, JSON.stringify(await response.json()));
        const call = calls.at(-1)!;
        assert.match(call.workflowConstraints ?? '', new RegExp(constraints[index]));
        assert.doesNotMatch(call.workflowConstraints ?? '', new RegExp(constraints[1 - index]));
        assert.equal(call.llm.apiKey, 'shared-transient-test-key');
        assert.equal(call.llm.model, 'qwen-plus');
        assert.ok(call.history?.some(({ content }) => content === '课程原文中队列使用先进先出。'));
        assert.ok(!call.history?.some(({ content }) => content === text), 'current user text must not repeat in history');
        if (index === 1) assert.ok(call.history?.some(({ role }) => role === 'assistant'));
        const saved = await store.getConsumerMessage(session.id, agentMessageId);
        assert.ok(saved?.text);
        assert.doesNotMatch(JSON.stringify(saved), /shared-transient-test-key/);
      }
      assert.equal(calls.length, 2);
      const savedSession = await store.getConsumerSession(
        new Request('http://localhost:3000', { headers: { Cookie: cookie } }),
        UNIFIED_ASSISTANT_WORKFLOW_ID, session.id,
      );
      assert.equal(savedSession?.workflowId, UNIFIED_ASSISTANT_WORKFLOW_ID);
      const selectedSession = await store.getConsumerSession(
        new Request('http://localhost:3000', { headers: { Cookie: cookie } }), workflowIds[0],
      );
      assert.equal(selectedSession, null, 'tool execution must not create a second workflow conversation');
    });

    it(`${mode} rejects another browser's anchor session and a legacy partition before tools`, async () => {
      const anchor = await newSession();
      const other = await newSession();
      const legacy = await newSession(workflowIds[0]);
      for (const [sessionId, cookie] of [
        [anchor.session.id, other.cookie], [legacy.session.id, legacy.cookie],
      ]) {
        const response = await requestTool(mode, {
          workflowId: workflowIds[0], assistantMode: 'unified', sessionId,
          agentMessageId: `denied_${mode}_${sessionId.slice(-10)}`,
        }, cookie);
        assert.equal(response.status, 404);
      }
      assert.equal(calls.length, 0);
    });

    it(`${mode} requires a real selected workflow and validates the mode before tools`, async () => {
      for (const workflowId of [undefined, UNIFIED_ASSISTANT_WORKFLOW_ID]) {
        const response = await requestTool(mode, { assistantMode: 'unified', workflowId });
        assert.equal(response.status, 409);
        assert.equal((await response.json() as { errorCode: string }).errorCode, 'WORKFLOW_REQUIRED');
      }
      const invalidMode = await requestTool(mode, { assistantMode: 'unknown', workflowId: workflowIds[0] });
      assert.equal(invalidMode.status, 400);
      const unpublished = await requestTool(mode, {
        assistantMode: 'unified', workflowId: 'wf_missing', agentMessageId: `missing_${mode}`,
      });
      assert.equal(unpublished.status, 409);
      assert.equal(calls.length, 0);
    });
  }
});
