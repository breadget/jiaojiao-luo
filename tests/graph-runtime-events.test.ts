import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { createTestDatabase } from './helpers/d1';
import { installDatabaseMock, seedWorkflow, ADMIN_TOKEN } from './helpers/api';
import { env } from './helpers/cloudflare-workers-stub';
import { canaryGraph } from './helpers/graph';
import {
  applyRunTelemetry,
  type RunTelemetryPayload,
} from '@/lib/workflow-graph/telemetry';
import { sanitizeTelemetryPayload } from '@/lib/server/node-telemetry';

const database = createTestDatabase();
installDatabaseMock(database.d1);
after(() => database.close());
let route: typeof import('@/app/api/n8n/events/route');
let versions: typeof import('@/lib/server/workflow-version-store');
let telemetry: typeof import('@/app/api/runs/[requestId]/telemetry/route');
before(async () => {
  env.URTORIS_INTERNAL_TOKEN = 'test-runtime-internal';
  env.URTORIS_ADMIN_TOKEN = ADMIN_TOKEN;
  env.URTORIS_GRAPH_RUNTIME_CANARY = '1';
  route = await import('@/app/api/n8n/events/route');
  telemetry = await import('@/app/api/runs/[requestId]/telemetry/route');
  versions = await import('@/lib/server/workflow-version-store');
  const graphs = await import('@/lib/server/workflow-graph-store');
  await seedWorkflow(database.d1, { id: 'wf_n8n_runtime', draftSteps: [] });
  await graphs.saveWorkflowGraphDraft({
    workflowId: 'wf_n8n_runtime',
    graph: canaryGraph('wf_n8n_runtime'),
    expectedRevision: 0,
  });
  await versions.publishWorkflowGraph({
    workflowId: 'wf_n8n_runtime',
    expectedRevision: 1,
  });
});
function event(id: string, seq = 0, type = 'execution.bound') {
  return {
    source: 'n8n-execution-data-v1',
    sourceSeq: seq,
    eventType: type,
    workflowId: 'wf_n8n_runtime',
    graphVersion: 1,
    requestId: 'request-' + id,
    executionId: id,
    sessionId: 'session-' + id,
    ...(seq === 0
      ? { triggerNodeId: 'U::node_trigger::primary' }
      : { node: 'U::node_agent::primary', at: 1700000000000 + seq }),
  };
}
function post(value: unknown, token = 'test-runtime-internal') {
  return route.POST(
    new Request('http://localhost/api/n8n/events', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(value),
    }),
  );
}
it('runtime is disabled in production and authenticates before any write', async () => {
  delete env.URTORIS_GRAPH_RUNTIME_CANARY;
  assert.equal((await post(event('disabled'))).status, 503);
  env.URTORIS_GRAPH_RUNTIME_CANARY = '1';
  assert.equal((await post(event('bad-auth'), 'wrong')).status, 401);
  assert.equal(
    database.raw.prepare('SELECT COUNT(*) n FROM n8n_runtime_streams').get()!.n,
    0,
  );
});
it('binding is idempotent with one receipt; workflow/session/execution conflicts return 409', async () => {
  assert.equal((await post(event('bind'))).status, 200);
  assert.equal((await post(event('bind'))).status, 200);
  assert.equal(
    database.raw
      .prepare("SELECT COUNT(*) n FROM n8n_events WHERE execution_id='bind'")
      .get()!.n,
    1,
  );
  for (const change of [
    { workflowId: 'wf_other' },
    { requestId: 'request-other' },
    { sessionId: 'session-other' },
    { graphVersion: 2 },
  ]) {
    assert.equal((await post({ ...event('bind'), ...change })).status, 409);
  }
  assert.equal(
    (await post({ ...event('missing'), requestId: '' })).status,
    400,
  );
  assert.equal(
    (await post({ ...event('unknown'), workflowId: 'wf_unknown' })).status,
    404,
  );
});
it('gaps, missing binding, altered retries and source bypass fail; duplicates never consume cursor', async () => {
  assert.equal((await post(event('sequence', 1, 'node.started'))).status, 409);
  await post(event('sequence'));
  assert.equal((await post(event('sequence', 2, 'node.finished'))).status, 409);
  const started = event('sequence', 1, 'node.started');
  assert.equal((await post(started)).status, 200);
  assert.equal((await post(started)).status, 200);
  assert.equal((await post({ ...started, node: 'alien' })).status, 409);
  assert.equal((await post({ ...started, source: undefined })).status, 409);
  assert.equal((await post(event('sequence', 2, 'node.finished'))).status, 200);
  assert.equal((await post(event('sequence', 3, 'run.completed'))).status, 200);
  assert.equal((await post(event('sequence', 4, 'node.started'))).status, 409);
});
it('node failure and workflow.error are stored redacted, then run.failed closes the stream', async () => {
  await post(event('failure'));
  const payload = {
    code: 'LLM_ERROR',
    message: 'Authorization: Bearer temporary-canary-value',
    detail: 'apiKey=temporary-value password=another-value',
    authorization: 'sensitive',
  };
  assert.equal(
    (await post({ ...event('failure', 1, 'node.error'), payload })).status,
    200,
  );
  assert.equal(
    (await post({ ...event('failure', 2, 'workflow.error'), payload })).status,
    200,
  );
  assert.equal((await post(event('failure', 3, 'run.failed'))).status, 200);
  const serialized = JSON.stringify(
    database.raw
      .prepare("SELECT * FROM n8n_events WHERE execution_id='failure'")
      .all(),
  );
  for (const secret of [
    'temporary-canary-value',
    'temporary-value',
    'another-value',
    'sensitive',
  ])
    assert.ok(!serialized.includes(secret));
  assert.match(serialized, /LLM_ERROR/);
  const sanitized = sanitizeTelemetryPayload({
    message: 'Bearer temporary-canary-value',
  });
  assert.equal(sanitized.truncated, true);
  assert.ok(
    !JSON.stringify(sanitized.payload).includes('temporary-canary-value'),
  );
});
it('telemetry reconnect drains bound and terminal, fixes version at binding, and exposes unmapped nodes', async () => {
  await post(event('telemetry'));
  const original = await versions.getActiveWorkflowVersion('wf_n8n_runtime');
  database.raw
    .prepare(`INSERT INTO runs (id,workflow_id,workflow_name,workflow_version,status,steps_json,logs_json,output_json,started_at,request_id,execution_id)
    VALUES ('run-runtime','wf_n8n_runtime','runtime',1,'completed','[]','[]','{}',1700000000000,'request-telemetry','telemetry')`)
    .run();
  await post(event('telemetry', 1, 'node.finished'));
  await post(event('telemetry', 2, 'node.started')); // deliberately late node start
  await post({
    ...event('telemetry', 3, 'node.started'),
    node: 'unknown-runtime-node',
  });
  await post(event('telemetry', 4, 'run.completed'));
  await versions.publishWorkflowGraph({
    workflowId: 'wf_n8n_runtime',
    expectedRevision: 1,
  });
  let cursor = 0;
  let runtime = {};
  const seen: number[] = [];
  const missing = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const response = await telemetry.GET(
      new Request(
        `http://localhost/api/runs/request-telemetry/telemetry?afterSeq=${cursor}&limit=2`,
        {
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        },
      ),
      { params: Promise.resolve({ requestId: 'request-telemetry' }) },
    );
    const body = (await response.json()) as Omit<
      RunTelemetryPayload,
      'events'
    > & { events: Array<{ seq: number }>; eventsComplete: boolean };
    assert.equal(response.status, 200);
    assert.equal(body.boundVersionId, original!.id);
    assert.equal(body.eventsComplete, true);
    runtime = applyRunTelemetry(runtime, body.nodes);
    seen.push(...body.events.map((e: { seq: number }) => e.seq));
    body.unmappedNodes.forEach((name: string) => missing.add(name));
    cursor = body.nextSeq;
  }
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5);
  assert.equal(
    (runtime as Record<string, { state: string }>).node_agent.state,
    'success',
  );
  assert.ok(missing.has('unknown-runtime-node'));
});
