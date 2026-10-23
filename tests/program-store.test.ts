import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { installDatabaseMock, nextAddress, seedWorkflow } from './helpers/api';
import { env } from './helpers/cloudflare-workers-stub';
import { createTestDatabase } from './helpers/d1';
import { createCourseProgramGraph } from '@/lib/workflow-program/templates';
import { executeProgram } from '@/lib/workflow-program/engine';
import type {
  ProgramArtifact,
  ProgramJob,
  ProgramStartRequest,
} from '@/lib/workflow-program/types';
import { UNIFIED_ASSISTANT_WORKFLOW_ID } from '@/lib/assistant-identity';

const database = createTestDatabase();
installDatabaseMock(database.d1);

let graphStore: typeof import('@/lib/server/workflow-graph-store');
let versions: typeof import('@/lib/server/workflow-version-store');
let programs: typeof import('@/lib/server/workflow-program-store');
let consumers: typeof import('@/lib/server/consumer-store');
let assistant: typeof import('@/lib/server/assistant-session');
let workflows: typeof import('@/lib/server/workflow-store');
let runRoute: typeof import('@/app/api/programs/runs/[id]/route');
let artifactRoute: typeof import('@/app/api/programs/runs/[id]/artifacts/[artifactId]/route');
const realFetch = globalThis.fetch;
const WORKER_TOKEN = 'store-test-worker-token-'.repeat(3);
const API_KEY = 'unit-program-model-key-never-persist';
const workerJobs = new Map<string, ProgramJob>();
const workerStarts = new Map<string, ProgramStartRequest>();
const controllers = new Map<string, AbortController>();
const artifactContents = new Map<string, string>();
const calls: Array<{
  method: string;
  path: string;
  body?: ProgramStartRequest;
}> = [];
let loseAcknowledgement = false;

function request(cookie?: string, path = '/api/programs/runs', method = 'GET') {
  return new Request(`https://urtoris.test${path}`, {
    method,
    headers: {
      Origin: 'https://urtoris.test',
      'X-Real-IP': nextAddress(),
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
}

function bodyFor(
  workflowId: string,
  requestId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    workflowId,
    requestId,
    input: { topic: '比例控制器', count: 1 },
    llm: {
      provider: 'openai',
      apiKey: API_KEY,
      baseUrl: 'https://model.example.test/v1',
      model: 'shared-selected-model',
      reasoningEffort: 'low',
    },
    ...extra,
  };
}

async function seedProgram(id: string, withModel = false) {
  await seedWorkflow(database.d1, { id, draftSteps: [] });
  const graph = createCourseProgramGraph(id, { withModel });
  const saved = await graphStore.saveWorkflowGraphDraft({
    workflowId: id,
    graph,
    expectedRevision: 0,
    updatedBy: 'program-test',
  });
  const published = await versions.publishWorkflowGraph({
    workflowId: id,
    expectedRevision: saved.graph.revision,
    executionTarget: 'program',
  });
  return { graph, saved, version: published.version };
}

async function owner(hex = 'a') {
  await assistant.ensureUnifiedAssistantWorkflow();
  const cookie = `urtoris_consumer=v1.${hex.repeat(64)}`;
  const resolved = await consumers.getOrCreateConsumerSession(
    request(cookie),
    UNIFIED_ASSISTANT_WORKFLOW_ID,
  );
  return { cookie, session: resolved.session };
}

async function count(table: string, where: string, value: string) {
  assert.ok(
    ['workflow_program_jobs', 'runs', 'workflow_versions'].includes(table),
  );
  assert.ok(['request_id', 'workflow_id'].includes(where));
  return (await database.d1
    .prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ${where} = ?`)
    .bind(value)
    .first<{ total: number }>())!.total;
}

async function dumpDatabase() {
  const tables = database.raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Array<{ name: string }>;
  return tables
    .map(({ name }) =>
      JSON.stringify(
        database.raw
          .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
          .all(),
      ),
    )
    .join('\n');
}

async function runWorker(
  id: string,
  retrieve = async () => [
    {
      id: 'source-1',
      filename: '控制基础.pdf',
      page: 7,
      excerpt: '比例控制器的输出与误差成正比。',
      score: 0.91,
    },
  ],
) {
  const start = workerStarts.get(id)!;
  const job = workerJobs.get(id)!;
  const controller = new AbortController();
  controllers.set(id, controller);
  job.status = 'running';
  job.startedAt = job.createdAt + 1;
  try {
    job.result = await executeProgram(start.plan, start.input, {
      llm: start.llm,
      signal: controller.signal,
      retrieveCourseSources: retrieve,
      onNode: async (snapshot) => {
        job.nodes[snapshot.id] = snapshot;
      },
      writeArtifact: async ({ name, mimeType, content }) => {
        const artifact: ProgramArtifact = {
          id: `artifact_${'a'.repeat(32)}`,
          name,
          mimeType,
          sizeBytes: new TextEncoder().encode(content).length,
        };
        artifactContents.set(`${id}/${artifact.id}`, content);
        job.artifacts.push(artifact);
        return artifact;
      },
    });
    job.status = 'completed';
    job.finishedAt = Date.now() + 2;
  } catch (cause) {
    if (!controller.signal.aborted) {
      job.status = 'failed';
      job.finishedAt = Date.now() + 2;
      job.error = {
        code: 'TEST_WORKER_ERROR',
        message: cause instanceof Error ? cause.message : 'failed',
      };
    }
  } finally {
    controllers.delete(id);
  }
}

async function workerFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input
        : input.url,
  );
  assert.equal(
    url.origin,
    'http://127.0.0.1:47999',
    'test must never call an external business service',
  );
  assert.equal(
    new Headers(init?.headers).get('Authorization'),
    `Bearer ${WORKER_TOKEN}`,
  );
  const method = init?.method ?? 'GET';
  if (init?.body !== undefined) assert.equal(typeof init.body, 'string');
  const body =
    typeof init?.body === 'string'
      ? (JSON.parse(init.body) as ProgramStartRequest)
      : undefined;
  calls.push({ method, path: url.pathname, body });
  if (method === 'POST' && url.pathname === '/v1/jobs') {
    assert.ok(body);
    assert.equal(
      workerStarts.has(body.id),
      false,
      'reservation must dispatch only once',
    );
    workerStarts.set(body.id, structuredClone(body));
    const job: ProgramJob = {
      id: body.id,
      workflowId: body.workflowId,
      workflowVersion: body.workflowVersion,
      versionId: body.versionId,
      status: 'queued',
      input: body.input,
      nodes: Object.fromEntries(
        body.plan.graph.nodes
          .filter((node) => !node.disabled)
          .map((node) => [
            node.id,
            { id: node.id, name: node.name, state: 'waiting' },
          ]),
      ),
      result: null,
      artifacts: [],
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };
    workerJobs.set(job.id, job);
    if (loseAcknowledgement)
      throw new Error('acknowledgement lost after worker accepted request');
    return Response.json(job);
  }
  const match = url.pathname.match(
    /^\/v1\/jobs\/(program_[a-f0-9]{32})(?:\/artifacts\/([A-Za-z0-9_-]+))?$/,
  );
  if (!match || !workerJobs.has(match[1]))
    return Response.json({ error: 'not found' }, { status: 404 });
  const job = workerJobs.get(match[1])!;
  if (match[2]) {
    const content = artifactContents.get(`${job.id}/${match[2]}`);
    return content === undefined
      ? new Response(null, { status: 404 })
      : new Response(content, {
          headers: {
            'Content-Type': 'text/markdown',
            'Content-Length': String(new TextEncoder().encode(content).length),
          },
        });
  }
  if (method === 'DELETE') {
    controllers.get(job.id)?.abort();
    job.status = 'cancelled';
    job.result = null;
    job.finishedAt = Date.now() + 3;
    job.error = { code: 'CANCELLED', message: '程序已取消。' };
    for (const node of Object.values(job.nodes))
      if (node.state === 'waiting') node.state = 'skipped';
      else if (node.state === 'running') {
        node.state = 'error';
        node.error = '程序已取消。';
        node.finishedAt = job.finishedAt;
      }
  }
  return Response.json(job);
}

describe('published PROGRAM stores with real SQLite ownership and idempotency', () => {
  before(async () => {
    env.WORKFLOW_PROGRAM_URL = 'http://127.0.0.1:47999';
    env.WORKFLOW_PROGRAM_TOKEN = WORKER_TOKEN;
    graphStore = await import('@/lib/server/workflow-graph-store');
    versions = await import('@/lib/server/workflow-version-store');
    programs = await import('@/lib/server/workflow-program-store');
    consumers = await import('@/lib/server/consumer-store');
    assistant = await import('@/lib/server/assistant-session');
    workflows = await import('@/lib/server/workflow-store');
    runRoute = await import('@/app/api/programs/runs/[id]/route');
    artifactRoute =
      await import('@/app/api/programs/runs/[id]/artifacts/[artifactId]/route');
    globalThis.fetch = workerFetch;
  });
  beforeEach(() => {
    calls.length = 0;
    workerJobs.clear();
    workerStarts.clear();
    controllers.clear();
    artifactContents.clear();
    loseAcknowledgement = false;
  });
  after(() => {
    globalThis.fetch = realFetch;
    database.close();
    delete env.WORKFLOW_PROGRAM_URL;
    delete env.WORKFLOW_PROGRAM_TOKEN;
  });

  it('publishes immutable real plans and restores the selected version without mutating snapshots', async () => {
    const first = await seedProgram('wf_program_immutable');
    const raw = await database.d1
      .prepare(
        'SELECT graph_json, compiled_json, compiled_hash, adapter FROM workflow_versions WHERE id = ?',
      )
      .bind(first.version.id)
      .first<{
        graph_json: string;
        compiled_json: string;
        compiled_hash: string;
        adapter: string;
      }>();
    assert.equal(raw!.adapter, 'program-v1');
    assert.equal(
      JSON.parse(raw!.compiled_json).graph.runtime.executionMode,
      'server',
    );
    const plan = await programs.getProgramPlan(first.version);
    assert.equal(plan.workflowVersion, 1);
    assert.equal((await versions.listNodeBindings(first.version.id)).length, 0);
    const changed = structuredClone(first.graph);
    changed.name = '新版本课程导出';
    changed.nodes.find(
      (node) => node.type === 'courseKnowledge',
    )!.config.query = '另一个主题';
    await graphStore.saveWorkflowGraphDraft({
      workflowId: changed.id,
      graph: changed,
      expectedRevision: 1,
      updatedBy: 'test',
    });
    const second = await versions.publishWorkflowGraph({
      workflowId: changed.id,
      expectedRevision: 2,
      executionTarget: 'program',
    });
    assert.equal(second.version.version, 2);
    assert.notEqual(second.version.compiledHash, first.version.compiledHash);
    assert.equal(
      (await programs.describeProgram(changed.id))!.versionId,
      second.version.id,
    );
    const rolledBack = await versions.rollbackWorkflowGraph({
      workflowId: changed.id,
      versionId: first.version.id,
    });
    assert.equal(rolledBack.previousVersionId, second.version.id);
    assert.equal(
      (await programs.describeProgram(changed.id))!.versionId,
      first.version.id,
    );
    assert.equal((await workflows.getWorkflowById(changed.id))!.version, 1);
    assert.deepEqual(
      await database.d1
        .prepare(
          'SELECT graph_json, compiled_json, compiled_hash, adapter FROM workflow_versions WHERE id = ?',
        )
        .bind(first.version.id)
        .first(),
      raw,
    );
    assert.equal(
      await count('workflow_versions', 'workflow_id', changed.id),
      2,
    );
  });

  it('creates an anonymous browser session and rejects foreign or missing-cookie ownership before polling/cancelling', async () => {
    const { version } = await seedProgram('wf_program_anonymous');
    const created = await programs.startOwnedProgram(
      request(),
      bodyFor(version.workflowId, 'program-anonymous-0001'),
    );
    assert.match(created.setCookie!, /^urtoris_consumer=v1\.[a-f0-9]{64};/);
    assert.match(created.setCookie!, /HttpOnly/);
    const cookie = created.setCookie!.split(';', 1)[0];
    assert.equal(
      (await programs.ownedProgramJob(request(cookie), created.job.id)).session
        .id,
      created.session.id,
    );
    const callCount = calls.length;
    for (const outsider of [
      request(),
      request(`urtoris_consumer=v1.${'f'.repeat(64)}`),
    ]) {
      await assert.rejects(
        programs.readOwnedProgramJob(outsider, created.job.id),
        (error: unknown) =>
          error instanceof programs.ProgramRequestError && error.status === 404,
      );
      await assert.rejects(
        programs.readOwnedProgramJob(outsider, created.job.id, true),
        (error: unknown) =>
          error instanceof programs.ProgramRequestError && error.status === 404,
      );
    }
    assert.equal(calls.length, callCount);
    assert.deepEqual(
      await programs.listOwnedProgramJobs(request(), version.workflowId),
      [],
    );
    assert.equal(
      (
        await programs.listOwnedProgramJobs(
          request(cookie),
          version.workflowId,
          created.session.id,
        )
      )[0].id,
      created.job.id,
    );
  });

  it('uses the SQLite nonce constraint to dispatch exactly once for concurrent same-session submissions', async () => {
    const { version } = await seedProgram('wf_program_concurrent');
    const browser = await owner('b');
    const body = bodyFor(version.workflowId, 'program-concurrent-0001', {
      consumerSessionId: browser.session.id,
    });
    const [first, second] = await Promise.all([
      programs.startOwnedProgram(request(browser.cookie), body),
      programs.startOwnedProgram(
        request(browser.cookie),
        structuredClone(body),
      ),
    ]);
    assert.equal(first.job.id, second.job.id);
    assert.equal(Number(first.replayed) + Number(second.replayed), 1);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
    assert.equal(
      await count(
        'workflow_program_jobs',
        'request_id',
        String(body.requestId),
      ),
      1,
    );
    assert.equal(await count('runs', 'request_id', String(body.requestId)), 1);
    const differentKey = structuredClone(body);
    (differentKey.llm as { apiKey: string }).apiKey =
      'rotated-key-stays-transient';
    assert.equal(
      (await programs.startOwnedProgram(request(browser.cookie), differentKey))
        .job.id,
      first.job.id,
    );
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
    await assert.rejects(
      programs.startOwnedProgram(request(browser.cookie), {
        ...body,
        input: { topic: 'changed', count: 1 },
      }),
      (error: unknown) =>
        error instanceof programs.ProgramRequestError && error.status === 409,
    );
    const other = await owner('c');
    await assert.rejects(
      programs.startOwnedProgram(request(other.cookie), {
        ...body,
        consumerSessionId: other.session.id,
      }),
      (error: unknown) =>
        error instanceof programs.ProgramRequestError && error.status === 409,
    );
  });

  it('replays the original reserved version after a newer publication without dispatching it again', async () => {
    const first = await seedProgram('wf_program_version_nonce');
    const browser = await owner('d');
    const body = bodyFor(
      first.version.workflowId,
      'program-version-nonce-0001',
      { versionId: first.version.id, consumerSessionId: browser.session.id },
    );
    const initial = await programs.startOwnedProgram(
      request(browser.cookie),
      body,
    );
    const changed = structuredClone(first.graph);
    changed.name = '第二版';
    changed.nodes[0].config.inputFields = [
      {
        name: 'different',
        label: '新版本字段',
        type: 'number',
        required: true,
      },
    ];
    changed.nodes.find(
      (node) => node.type === 'courseKnowledge',
    )!.config.query = '新主题';
    await graphStore.saveWorkflowGraphDraft({
      workflowId: changed.id,
      graph: changed,
      expectedRevision: 1,
      updatedBy: 'test',
    });
    await versions.publishWorkflowGraph({
      workflowId: changed.id,
      expectedRevision: 2,
      executionTarget: 'program',
    });
    const replay = await programs.startOwnedProgram(
      request(browser.cookie),
      body,
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.job.id, initial.job.id);
    assert.equal(replay.job.versionId, first.version.id);
    assert.equal(replay.job.workflowVersion, 1);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  });

  it('keeps keys transient, rejects caller supplied plans, and never retries after a lost acknowledgement', async () => {
    const { version } = await seedProgram('wf_program_transient');
    const browser = await owner('e');
    const body = bodyFor(version.workflowId, 'program-key-ack-0001', {
      consumerSessionId: browser.session.id,
    });
    for (const field of [
      'graph',
      'plan',
      'compiledJson',
      'apiKey',
      'filePath',
      'sql',
    ])
      await assert.rejects(
        programs.startOwnedProgram(request(browser.cookie), {
          ...body,
          [field]: {},
        }),
      );
    assert.equal(calls.length, 0);
    loseAcknowledgement = true;
    const started = await programs.startOwnedProgram(
      request(browser.cookie),
      body,
    );
    assert.equal(started.job.status, 'queued');
    assert.equal(
      (await programs.startOwnedProgram(request(browser.cookie), body)).job.id,
      started.job.id,
    );
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
    assert.equal(
      calls[0].body!.llm.apiKey,
      API_KEY,
      'key reaches only the authenticated internal execution request',
    );
    assert.equal((await dumpDatabase()).includes(API_KEY), false);
    assert.equal(JSON.stringify(started).includes(API_KEY), false);
    assert.equal(
      (await workflows.getRunByRequestId(String(body.requestId)))!.engine,
      'program',
    );
  });

  it('synchronizes actual engine facts from queued to running to completed and preserves terminal results', async () => {
    const { version } = await seedProgram('wf_program_real_states');
    const browser = await owner('1');
    const body = bodyFor(version.workflowId, 'program-real-states-0001', {
      consumerSessionId: browser.session.id,
    });
    const started = await programs.startOwnedProgram(
      request(browser.cookie),
      body,
    );
    const queuedRun = await workflows.getRunByRequestId(String(body.requestId));
    assert.equal(queuedRun!.status, 'queued');
    assert.equal(queuedRun!.finishedAt, null);
    assert.deepEqual(queuedRun!.logs, []);
    assert.equal(queuedRun!.output.processed, 0);
    let signalReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      signalReached = resolve;
    });
    let release!: (
      value: Array<{
        id: string;
        filename: string;
        page: number;
        excerpt: string;
        score: number;
      }>,
    ) => void;
    const waiting = new Promise<
      Array<{
        id: string;
        filename: string;
        page: number;
        excerpt: string;
        score: number;
      }>
    >((resolve) => {
      release = resolve;
    });
    const execution = runWorker(started.job.id, async () => {
      signalReached();
      return waiting;
    });
    await reached;
    const running = await programs.readOwnedProgramJob(
      request(browser.cookie),
      started.job.id,
    );
    assert.equal(running.status, 'running');
    assert.equal(running.nodes.course_sources.state, 'running');
    assert.equal(running.nodes.course_input.state, 'success');
    assert.equal(running.nodes.course_output.state, 'waiting');
    const runningRun = await workflows.getRunByRequestId(
      String(body.requestId),
    );
    assert.equal(runningRun!.status, 'running');
    assert.equal(runningRun!.finishedAt, null);
    release([
      {
        id: 'source-actual',
        filename: '实际课程.pdf',
        page: 9,
        excerpt: '这是实际检索返回的比例控制器原文。',
        score: 1,
      },
    ]);
    await execution;
    const completed = await programs.readOwnedProgramJob(
      request(browser.cookie),
      started.job.id,
    );
    assert.equal(completed.status, 'completed');
    assert.match(completed.result!.text, /实际课程.pdf/);
    assert.equal(completed.result!.sources[0].page, 9);
    assert.equal(completed.artifacts.length, 1);
    const completedRun = await workflows.getRunByRequestId(
      String(body.requestId),
    );
    assert.equal(completedRun!.status, 'completed');
    assert.equal(completedRun!.output.result, completed.result!.text);
    assert.equal(completedRun!.degraded, false);
    const readCalls = calls.length;
    workerJobs.get(started.job.id)!.status = 'running';
    workerJobs.get(started.job.id)!.finishedAt = null;
    assert.equal(
      (
        await programs.readOwnedProgramJob(
          request(browser.cookie),
          started.job.id,
        )
      ).status,
      'completed',
    );
    assert.equal(
      calls.length,
      readCalls,
      'cached terminal jobs do not poll and cannot regress',
    );
    assert.equal((await dumpDatabase()).includes(API_KEY), false);
  });

  it('cancels an active engine job with ownership and stores a cancelled public job plus failed run', async () => {
    const { version } = await seedProgram('wf_program_cancel_store');
    const browser = await owner('2');
    const body = bodyFor(version.workflowId, 'program-cancel-store-0001', {
      consumerSessionId: browser.session.id,
    });
    const started = await programs.startOwnedProgram(
      request(browser.cookie),
      body,
    );
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const execution = runWorker(started.job.id, async () => {
      reached();
      return new Promise(() => undefined);
    });
    await waiting;
    const cancelled = await programs.readOwnedProgramJob(
      request(browser.cookie),
      started.job.id,
      true,
    );
    await execution;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.result, null);
    assert.equal(cancelled.artifacts.length, 0);
    assert.equal(cancelled.nodes.course_sources.state, 'error');
    assert.equal(cancelled.nodes.course_output.state, 'skipped');
    const run = await workflows.getRunByRequestId(String(body.requestId));
    assert.equal(run!.status, 'failed');
    assert.equal(run!.errorCode, 'CANCELLED');
    assert.equal(run!.output.summary, '程序已取消');
    assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1);
    assert.equal(
      (await programs.startOwnedProgram(request(browser.cookie), body))
        .replayed,
      true,
    );
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  });

  it('checks route ownership before polling, cancellation or artifact HTTP and returns only the owned file', async () => {
    const { version } = await seedProgram('wf_program_download');
    const browser = await owner('3');
    const started = await programs.startOwnedProgram(
      request(browser.cookie),
      bodyFor(version.workflowId, 'program-download-0001', {
        consumerSessionId: browser.session.id,
      }),
    );
    await runWorker(started.job.id);
    const completed = await programs.readOwnedProgramJob(
      request(browser.cookie),
      started.job.id,
    );
    const artifact = completed.artifacts[0];
    const context = {
      params: Promise.resolve({ id: completed.id, artifactId: artifact.id }),
    };
    const path = `/api/programs/runs/${completed.id}/artifacts/${artifact.id}`;
    const callCount = calls.length;
    for (const cookie of [undefined, `urtoris_consumer=v1.${'9'.repeat(64)}`]) {
      assert.equal((await runRoute.GET(request(cookie), context)).status, 404);
      assert.equal(
        (
          await runRoute.DELETE(
            request(cookie, `/api/programs/runs/${completed.id}`, 'DELETE'),
            context,
          )
        ).status,
        404,
      );
      assert.equal(
        (await artifactRoute.GET(request(cookie, path), context)).status,
        404,
      );
    }
    assert.equal(
      calls.length,
      callCount,
      'no worker request may precede ownership validation',
    );
    const unknown = {
      params: Promise.resolve({
        id: completed.id,
        artifactId: 'artifact_unknown',
      }),
    };
    assert.equal(
      (await artifactRoute.GET(request(browser.cookie, path), unknown)).status,
      404,
    );
    assert.equal(calls.length, callCount);
    const response = await artifactRoute.GET(
      request(browser.cookie, path),
      context,
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), completed.result!.text);
    assert.match(response.headers.get('Content-Disposition')!, /attachment/);
    assert.match(response.headers.get('Cache-Control')!, /private, no-store/);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(
      calls.filter((call) => call.path.includes('/artifacts/')).length,
      1,
    );
    artifactContents.set(
      `${completed.id}/${artifact.id}`,
      `${completed.result!.text}unexpected appended bytes`,
    );
    assert.equal(
      (await artifactRoute.GET(request(browser.cookie, path), context)).status,
      502,
    );
  });

  it('honors the shared adapter claim and cannot dispatch a program while another execution owns the nonce', async () => {
    const { version } = await seedProgram('wf_program_shared_claim');
    const browser = await owner('4');
    const nonce = 'program-shared-claim-0001';
    const replay = await import('@/lib/server/replay');
    await replay.claimRunRequest(nonce);
    try {
      await assert.rejects(
        programs.startOwnedProgram(
          request(browser.cookie),
          bodyFor(version.workflowId, nonce, {
            consumerSessionId: browser.session.id,
          }),
        ),
        (error: unknown) =>
          error instanceof programs.ProgramRequestError &&
          error.status === 409 &&
          error.code === 'REQUEST_IN_PROGRESS',
      );
      assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
      assert.equal(
        await count('workflow_program_jobs', 'request_id', nonce),
        0,
      );
    } finally {
      await replay.releaseClaim(nonce);
    }
    assert.equal(
      (
        await programs.startOwnedProgram(
          request(browser.cookie),
          bodyFor(version.workflowId, nonce, {
            consumerSessionId: browser.session.id,
          }),
        )
      ).replayed,
      false,
    );
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  });

  it('redacts a transient model key echoed in user input before reserving a job or run in D1', async () => {
    const { version } = await seedProgram('wf_program_input_key_echo');
    const browser = await owner('5');
    loseAcknowledgement = true;
    const topic = `请解释这段文本：${API_KEY}`;
    const started = await programs.startOwnedProgram(
      request(browser.cookie),
      bodyFor(version.workflowId, 'program-key-echo-0001', {
        input: { topic, count: 1 },
        consumerSessionId: browser.session.id,
      }),
    );
    assert.equal(
      workerStarts.get(started.job.id)!.input.topic,
      topic,
      'only transient worker execution receives the original input',
    );
    assert.equal(JSON.stringify(started.job).includes(API_KEY), false);
    assert.equal((await dumpDatabase()).includes(API_KEY), false);
    assert.equal(
      (
        await programs.startOwnedProgram(
          request(browser.cookie),
          bodyFor(version.workflowId, 'program-key-echo-0001', {
            input: { topic, count: 1 },
            consumerSessionId: browser.session.id,
          }),
        )
      ).job.id,
      started.job.id,
    );
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  });
});
