import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it, mock } from 'node:test';
import { installDatabaseMock, nextAddress, seedWorkflow } from './helpers/api';
import { migrationStatements, SqliteD1 } from './helpers/d1';
import { resetEnv } from './helpers/cloudflare-workers-stub';
import { createCourseProgramGraph } from '@/lib/workflow-program/templates';
import { UNIFIED_ASSISTANT_WORKFLOW_ID } from '@/lib/assistant-identity';
import type {
  ProgramJob,
  ProgramStartRequest,
} from '@/lib/workflow-program/types';
import type { WorkflowRun } from '@/lib/workflow-types';

type Json = Record<string, unknown>;
const temporary = mkdtempSync(join(tmpdir(), 'urtoris-program-chat-'));
const raw = new DatabaseSync(join(temporary, 'chat.sqlite'));
raw.exec('PRAGMA foreign_keys = ON');
for (const { sql } of migrationStatements()) raw.exec(sql);
const d1 = new SqliteD1(raw);
installDatabaseMock(d1);
mock.module('@/lib/server/course-assistant-client', {
  exports: {
    retrieveCourseSources: async (question: string) => ({
      question,
      sources: [
        {
          id: 'queue_page_9',
          filename: '课程.pdf',
          page: 9,
          excerpt: '队列遵循先进先出原则。',
          score: 0.9,
        },
      ],
    }),
  },
} as unknown as Parameters<typeof mock.module>[1]);

const WORKFLOW = 'wf_program_chat';
const MISSING_INPUT = 'wf_program_missing';
const SECRET = 'program-chat-key-never-persist';
const executionJobs = new Map<string, ProgramJob>();
const dispatched: ProgramStartRequest[] = [];
const modelCalls: Json[] = [];
let server: ReturnType<typeof createServer>;
let origin = '';
let sequence = 0;
let route: typeof import('@/app/api/agent/chat/route');
let store: typeof import('@/lib/server/consumer-store');
let recovery: typeof import('@/lib/server/consumer-chat');
let history: typeof import('@/lib/server/conversation-history');
let programStore: typeof import('@/lib/server/workflow-program-store');

async function handle(request: IncomingMessage, response: ServerResponse) {
  const buffers: Buffer[] = [];
  for await (const chunk of request) buffers.push(Buffer.from(chunk));
  const send = (value: unknown, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  if (request.url === '/v1/chat/completions') {
    assert.equal(request.headers.authorization, `Bearer ${SECRET}`);
    const body = JSON.parse(Buffer.concat(buffers).toString()) as Json;
    modelCalls.push(body);
    const tools = body.tools as
      | Array<{ function: { name: string } }>
      | undefined;
    const selected = tools?.some(
      (tool) => tool.function.name === 'execute_selected_workflow',
    );
    send({
      model: 'program-router-actual',
      choices: [
        {
          message: selected
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_program',
                    type: 'function',
                    function: {
                      name: 'execute_selected_workflow',
                      arguments: '{}',
                    },
                  },
                ],
              }
            : {
                role: 'assistant',
                content: '队列遵循先进先出 [1]，见第 9 页。',
              },
        },
      ],
    });
    return;
  }
  assert.equal(
    request.headers.authorization,
    `Bearer ${'program-secret-'.repeat(3)}`,
  );
  if (request.url === '/v1/jobs' && request.method === 'POST') {
    const body = JSON.parse(
      Buffer.concat(buffers).toString(),
    ) as ProgramStartRequest;
    dispatched.push(body);
    const now = Date.now();
    const job: ProgramJob = {
      id: body.id,
      workflowId: body.workflowId,
      workflowVersion: body.workflowVersion,
      versionId: body.versionId,
      status: 'running',
      input: body.input,
      nodes: Object.fromEntries(
        body.plan.executionNodeIds.map((id, index) => [
          id,
          {
            id,
            name: body.plan.graph.nodes.find((node) => node.id === id)!.name,
            state: index === 0 ? 'running' : 'waiting',
            ...(index === 0 ? { startedAt: now } : {}),
          },
        ]),
      ),
      result: null,
      artifacts: [],
      createdAt: now,
      startedAt: now,
      finishedAt: null,
    };
    executionJobs.set(job.id, job);
    send(job, 202);
    return;
  }
  const jobId = request.url?.split('/').at(-1) ?? '';
  const job = executionJobs.get(jobId);
  send(job ?? { error: 'missing job' }, job ? 200 : 404);
}

function request(body: Json, cookie?: string) {
  return new Request('http://urtoris.test/api/agent/chat', {
    method: 'POST',
    headers: {
      Origin: 'http://urtoris.test',
      'Content-Type': 'application/json',
      'X-Real-IP': nextAddress(),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function conversation(
  message = '运行当前工作流，学习队列。',
  workflowId = WORKFLOW,
) {
  sequence += 1;
  const owner = new Request('http://urtoris.test/api/consumer/session', {
    headers: { 'X-Urtoris-Consumer-Client': '1' },
  });
  const resolved = await store.getOrCreateConsumerSession(
    owner,
    UNIFIED_ASSISTANT_WORKFLOW_ID,
    undefined,
  );
  const cookie = resolved.setCookie!.split(';', 1)[0];
  const requestId = `program-chat-${sequence}`;
  const userMessageId = `program_user_${sequence}`;
  const agentMessageId = `program_agent_${sequence}`;
  const now = Date.now();
  await store.upsertConsumerMessage(resolved.session, {
    id: userMessageId,
    role: 'user',
    status: 'completed',
    text: message,
    createdAt: now - 100,
  });
  await store.upsertConsumerMessage(resolved.session, {
    id: agentMessageId,
    role: 'agent',
    status: 'working',
    text: '',
    metadata: { chatRequestId: requestId },
    createdAt: now - 50,
  });
  return {
    session: resolved.session,
    cookie,
    payload: {
      assistantMode: 'unified',
      workflowId,
      message,
      requestId,
      consumerSessionId: resolved.session.id,
      sessionId: resolved.session.engineSessionId,
      userMessageId,
      agentMessageId,
      apiKey: SECRET,
      provider: 'custom',
      baseUrl: `${origin}/v1`,
      model: 'program-router',
      reasoningEffort: 'high',
    } as Json,
    agentMessageId,
  };
}

async function post(body: Json, cookie?: string) {
  const response = await route.POST(request(body, cookie));
  return { response, payload: (await response.json()) as Json };
}

before(async () => {
  server = createServer((request, response) => {
    void handle(request, response).catch((cause) => {
      response.writeHead(500);
      response.end(String(cause));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resetEnv({
    WORKFLOW_PROGRAM_URL: origin,
    WORKFLOW_PROGRAM_TOKEN: 'program-secret-'.repeat(3),
    URTORIS_API_TOKEN: 's'.repeat(48),
  });
  const { ensureUnifiedAssistantWorkflow } =
    await import('@/lib/server/assistant-session');
  await ensureUnifiedAssistantWorkflow();
  const { saveWorkflowGraphDraft } =
    await import('@/lib/server/workflow-graph-store');
  const { publishWorkflowGraph } =
    await import('@/lib/server/workflow-version-store');
  for (const id of [WORKFLOW, MISSING_INPUT]) {
    await seedWorkflow(d1, {
      id,
      publishedSteps: [
        {
          id: 'step_output',
          title: '结果',
          detail: '返回实际结果',
          kind: 'output',
        },
      ],
      version: 1,
      n8nWebhookUrl: `${origin}/webhook/should-never-run`,
    });
    const graph = createCourseProgramGraph(id, { withModel: false });
    if (id === MISSING_INPUT)
      (graph.nodes[0].config.inputFields as unknown[]).push({
        name: 'chapter',
        label: '章节编号',
        type: 'number',
        required: true,
      });
    const saved = await saveWorkflowGraphDraft({
      workflowId: id,
      graph,
      expectedRevision: 0,
    });
    await publishWorkflowGraph({
      workflowId: id,
      expectedRevision: saved.graph.revision,
      executionTarget: 'program',
    });
  }
  route = await import('@/app/api/agent/chat/route');
  store = await import('@/lib/server/consumer-store');
  recovery = await import('@/lib/server/consumer-chat');
  history = await import('@/lib/server/conversation-history');
  programStore = await import('@/lib/server/workflow-program-store');
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  raw.close();
  rmSync(temporary, { recursive: true, force: true });
});

describe('shared chat to published background program bridge', () => {
  it('keeps ordinary grounded course questions on the shared model without executing the selected program', async () => {
    const task = await conversation('队列是什么？');
    const before = dispatched.length;
    const result = await post(task.payload, task.cookie);
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.mode, 'model');
    assert.equal(result.payload.programJobId, undefined);
    assert.equal(dispatched.length, before);
    assert.equal(modelCalls.at(-1)?.tools, undefined);
  });

  it('starts the active immutable graph only after the actual shared model tool choice, and persists the acknowledgement', async () => {
    const task = await conversation();
    const before = dispatched.length;
    const result = await post(
      {
        ...task.payload,
        input: { topic: 'forged override', count: 20 },
        graph: { nodes: [] },
      },
      task.cookie,
    );
    assert.equal(result.response.status, 202, JSON.stringify(result.payload));
    assert.equal(result.payload.mode, 'program');
    assert.equal(result.payload.executionMode, 'program');
    assert.equal(result.payload.degraded, false);
    assert.match(String(result.payload.reply), /已启动.*运行详情/);
    assert.doesNotMatch(String(result.payload.reply), /已完成|执行成功/);
    const run = result.payload.run as WorkflowRun;
    assert.equal(run.engine, 'program');
    assert.equal(run.status, 'running');
    assert.equal(run.output.programJobId, result.payload.programJobId);
    assert.equal(dispatched.length, before + 1);
    const sent = dispatched.at(-1)!;
    assert.deepEqual(sent.input, {
      topic: task.payload.message,
      difficulty: '基础',
      count: 5,
    });
    assert.equal(sent.llm.apiKey, SECRET);
    assert.equal(sent.llm.reasoningEffort, 'high');
    const message = await store.getConsumerMessage(
      task.session.id,
      task.agentMessageId,
    );
    assert.equal(message?.status, 'completed');
    assert.equal(message?.metadata.mode, 'program');
    assert.equal(message?.metadata.programJobId, result.payload.programJobId);
    assert.equal(message?.text, result.payload.reply);
    assert.doesNotMatch(
      JSON.stringify(raw.prepare('SELECT * FROM workflow_program_jobs').all()),
      new RegExp(SECRET),
    );
    assert.doesNotMatch(
      JSON.stringify(raw.prepare('SELECT * FROM runs').all()),
      new RegExp(SECRET),
    );
    assert.doesNotMatch(
      JSON.stringify(await store.listConsumerMessages(task.session.id)),
      new RegExp(SECRET),
    );
    const callsBeforeReplay = modelCalls.length;
    const replay = await post(task.payload, task.cookie);
    assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
    assert.equal(replay.payload.replayed, true);
    assert.equal(replay.payload.programJobId, result.payload.programJobId);
    assert.equal(replay.payload.mode, 'program');
    assert.equal(modelCalls.length, callsBeforeReplay);
    assert.equal(dispatched.length, before + 1);
  });

  it('restores a lost running acknowledgement after 120 seconds and keeps its job ID in model history', async () => {
    const task = await conversation();
    const started = await post(task.payload, task.cookie);
    assert.equal(started.response.status, 202);
    const old = Date.now() - recovery.CHAT_RECOVERY_TIMEOUT_MS - 5000;
    await store.upsertConsumerMessage(task.session, {
      id: task.agentMessageId,
      role: 'agent',
      status: 'working',
      text: '',
      metadata: { chatRequestId: task.payload.requestId },
      createdAt: old,
    });
    const working = await store.getConsumerMessage(
      task.session.id,
      task.agentMessageId,
    );
    const recoveryAt = Date.now() + recovery.CHAT_RECOVERY_TIMEOUT_MS + 5000;
    assert.ok(
      working!.createdAt + recovery.CHAT_RECOVERY_TIMEOUT_MS < recoveryAt,
    );
    assert.equal(
      await recovery.reconcileChatReplies(task.session, [working!], recoveryAt),
      true,
    );
    const restored = await store.getConsumerMessage(
      task.session.id,
      task.agentMessageId,
    );
    assert.equal(restored?.status, 'completed');
    assert.equal(restored?.metadata.failed, false);
    assert.equal(restored?.metadata.programJobId, started.payload.programJobId);
    assert.match(restored!.text, /已启动/);
    const context = history.buildConversationHistory([restored!]);
    assert.match(context[0].content, /programJobId/);
    assert.match(
      context[0].content,
      new RegExp(String(started.payload.programJobId)),
    );
  });

  it('claims concurrent chat requests once before routing and starting the background job', async () => {
    const task = await conversation();
    const callsBefore = modelCalls.length;
    const jobsBefore = dispatched.length;
    const results = await Promise.all([
      post(task.payload, task.cookie),
      post(task.payload, task.cookie),
    ]);
    assert.ok(
      results.every((result) => result.response.ok),
      JSON.stringify(results.map((result) => result.payload)),
    );
    assert.equal(
      results[0].payload.programJobId,
      results[1].payload.programJobId,
    );
    assert.equal(modelCalls.length, callsBefore + 1);
    assert.equal(dispatched.length, jobsBefore + 1);
  });

  it('asks for other missing published inputs instead of inventing values or starting a job', async () => {
    const task = await conversation(
      '运行当前工作流，学习队列。',
      MISSING_INPUT,
    );
    const before = dispatched.length;
    const result = await post(task.payload, task.cookie);
    assert.equal(result.response.status, 409, JSON.stringify(result.payload));
    assert.equal(result.payload.errorCode, 'PROGRAM_INPUT_PANEL_REQUIRED');
    assert.match(String(result.payload.error), /章节编号.*运行程序.*参数面板/);
    assert.equal(result.payload.run, undefined);
    assert.equal(dispatched.length, before);
    assert.equal(
      raw
        .prepare('SELECT count(*) AS count FROM runs WHERE request_id = ?')
        .get(String(task.payload.requestId))?.count,
      0,
    );
    assert.equal(
      raw
        .prepare(
          'SELECT count(*) AS count FROM run_claims WHERE request_id = ?',
        )
        .get(String(task.payload.requestId))?.count,
      0,
    );
  });

  it('never drops a nonunified published program into the legacy simulated or webhook paths', async () => {
    const before = modelCalls.length;
    const jobsBefore = dispatched.length;
    const result = await post({
      workflowId: WORKFLOW,
      message: '运行这个工作流。',
      apiKey: '',
      provider: 'custom',
      baseUrl: `${origin}/v1`,
      model: 'program-router',
    });
    assert.equal(result.response.status, 409, JSON.stringify(result.payload));
    assert.equal(result.payload.errorCode, 'PROGRAM_INPUT_PANEL_REQUIRED');
    assert.match(String(result.payload.error), /运行程序.*参数面板/);
    assert.equal(result.payload.run, undefined);
    assert.equal(modelCalls.length, before);
    assert.equal(dispatched.length, jobsBefore);
  });

  it('keeps program identity and failure semantics on replay after an executor-confirmed failure', async () => {
    const task = await conversation();
    const started = await post(task.payload, task.cookie);
    const jobId = String(started.payload.programJobId);
    const job = executionJobs.get(jobId)!;
    executionJobs.set(jobId, {
      ...job,
      status: 'failed',
      finishedAt: Date.now(),
      error: {
        code: 'COURSE_RETRIEVAL_UNAVAILABLE',
        message: '课程检索暂时不可用。',
      },
    });
    await programStore.readOwnedProgramJob(
      request(task.payload, task.cookie),
      jobId,
    );
    const callsBefore = modelCalls.length;
    const jobsBefore = dispatched.length;
    const replay = await post(task.payload, task.cookie);
    assert.equal(replay.response.status, 502, JSON.stringify(replay.payload));
    assert.equal(replay.payload.mode, 'program');
    assert.equal(replay.payload.programJobId, jobId);
    assert.match(String(replay.payload.error), /课程检索/);
    assert.equal((replay.payload.run as WorkflowRun).status, 'failed');
    assert.equal(
      (await store.getConsumerMessage(task.session.id, task.agentMessageId))
        ?.metadata.programJobId,
      jobId,
    );
    assert.equal(modelCalls.length, callsBefore);
    assert.equal(dispatched.length, jobsBefore);
  });
});
