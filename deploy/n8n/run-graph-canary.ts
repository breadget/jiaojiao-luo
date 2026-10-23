/** Real HTTP + real n8n + local workerd D1. No mock engine or database. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { RunTelemetryPayload } from '../../lib/workflow-graph/telemetry';
type SiteResponse = Omit<RunTelemetryPayload, 'events'> & {
  adapterLocked: boolean;
  version: { compiledHash: string; version: number };
  eventsComplete: boolean;
  envelope: {
    success: boolean;
    mode: string;
    degraded: boolean;
    error: unknown;
    data: { outputNodeId: string };
  };
  events: Array<{ eventType: string; payload: { code: string } }>;
};
const root = process.argv[2];
if (process.env.URTORIS_CLONE_CANARY !== '1' || !root)
  throw new Error('CLONE_MARKER_REQUIRED');
const marker = JSON.parse(
  readFileSync(join(root, 'graph-runtime-clone.json'), 'utf8'),
);
assert.equal(marker.marker, 'isolated-urtoris-graph-canary');
const secrets = JSON.parse(
  readFileSync(join(root, 'test-secrets.json'), 'utf8'),
);
const graph = JSON.parse(readFileSync(join(root, 'graph.json'), 'utf8'));
async function site(path: string, body?: unknown, method = 'POST') {
  const response = await fetch('http://127.0.0.1:3000' + path, {
    method: body === undefined ? 'GET' : method,
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${secrets.admin}`,
      Origin: 'http://127.0.0.1:3000',
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90000),
  });
  const result = (await response.json()) as SiteResponse;
  assert.equal(
    response.status,
    200,
    `${path}: ${JSON.stringify(result).slice(0, 500)}`,
  );
  return result;
}
if (process.argv.includes('--setup') || process.argv.includes('--publish')) {
  if (process.argv.includes('--setup')) {
    await site('/api/workflows', {
      id: graph.id,
      action: 'publish',
      name: graph.name,
      description: 'Isolated canary',
      steps: [
        {
          id: 'canary-step',
          title: 'Canary',
          detail: 'Real n8n execution',
          kind: 'compose',
        },
      ],
      n8nWebhookUrl:
        'http://127.0.0.1:5679/webhook/urtoris/wf_n8n_graph_canary',
    });
    await site(
      `/api/workflows/${graph.id}/graph`,
      { graph, expectedRevision: 0 },
      'PUT',
    );
  }
  const publication = await site(`/api/workflows/${graph.id}/graph/publish`, {
    expectedRevision: 1,
  });
  assert.equal(publication.adapterLocked, true);
  marker.workflows[0].graphVersion = publication.version.version;
  marker.workflows[0].compiledHash = publication.version.compiledHash;
  writeFileSync(
    join(root, 'graph-runtime-clone.json'),
    JSON.stringify(marker, null, 2),
  );
  console.log(
    JSON.stringify({
      setup: true,
      compiledHash: publication.version.compiledHash,
    }),
  );
} else {
  const cases: Array<Record<string, unknown>> = [];
  const prefix = randomUUID();
  const initialRequests = (await (
    await fetch('http://127.0.0.1:5690/canary/requests')
  ).json()) as unknown[];
  for (const testCase of [
    {
      name: 'high',
      mode: 'success',
      session: 'A',
      urgency: 'high',
      message: 'remember CANARY_ALPHA',
    },
    {
      name: 'memory-same',
      mode: 'success',
      session: 'A',
      urgency: 'normal',
      message: 'repeat memory',
    },
    {
      name: 'memory-other',
      mode: 'success',
      session: 'B',
      urgency: 'normal',
      message: 'new session',
    },
    {
      name: 'wrong-key',
      mode: 'wrong-key',
      session: 'C',
      urgency: 'high',
      message: 'reject invalid test credential',
    },
    {
      name: 'network',
      mode: 'network',
      session: 'D',
      urgency: 'high',
      message: 'network disconnect',
    },
    {
      name: 'malformed',
      mode: 'malformed',
      session: 'E',
      urgency: 'normal',
      message: 'invalid provider JSON',
    },
  ]) {
    const response = await fetch('http://127.0.0.1:5690/canary/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: testCase.mode }),
    });
    assert.equal(response.status, 200);
    const requestId = `${prefix}-${testCase.name}`;
    const result = await site('/api/runs', {
      workflowId: graph.id,
      requestId,
      sessionId: `${prefix}-${testCase.session}`,
      message: testCase.message,
      input: { channel: 'web', urgency: testCase.urgency },
    });
    assert.equal(
      result.envelope.success,
      testCase.mode === 'success',
      JSON.stringify({ case: testCase.name, error: result.envelope.error }),
    );
    if (testCase.mode === 'success') {
      assert.equal(result.envelope.mode, 'llm');
      assert.equal(result.envelope.degraded, false);
      assert.equal(
        result.envelope.data.outputNodeId,
        testCase.urgency === 'high' ? 'node_high' : 'node_normal',
      );
    }
    let page!: SiteResponse;
    for (let attempt = 0; attempt < 30; attempt++) {
      page = await site(
        `/api/runs/${requestId}/telemetry?afterSeq=0&limit=100`,
      );
      if (page.eventsComplete) break;
      await setTimeout(1000);
    }
    assert.equal(
      page.eventsComplete,
      true,
      `No terminal telemetry for ${testCase.name}`,
    );
    assert.equal(page.events[0]?.eventType, 'execution.bound');
    assert.equal(
      page.events.at(-1)?.eventType,
      testCase.mode === 'success' ? 'run.completed' : 'run.failed',
    );
    const repeat = await site(
      `/api/runs/${requestId}/telemetry?afterSeq=${page.nextSeq}`,
    );
    assert.equal(repeat.events.length, 0);
    if (testCase.mode !== 'success') {
      const failure = page.events.find(
        (e: { eventType: string }) => e.eventType === 'workflow.error',
      );
      assert.equal(
        failure?.payload.code,
        testCase.mode === 'network' ? 'NETWORK_ERROR' : 'LLM_ERROR',
      );
    }
    cases.push({
      name: testCase.name,
      requestId,
      executionId: page.run.executionId,
      status: page.run.status,
      events: page.events.length,
      nodes: page.nodes.map((n: { nodeId: string; state: string }) => ({
        nodeId: n.nodeId,
        state: n.state,
      })),
    });
    writeFileSync(
      join(root, 'canary-results.json'),
      JSON.stringify({ complete: false, cases }, null, 2),
    );
    console.log(JSON.stringify(cases.at(-1)));
  }
  const requests = (await (
    await fetch('http://127.0.0.1:5690/canary/requests')
  ).json()) as Array<{ mode: string; messages: Array<{ content: string }> }>;
  const successful = requests
    .slice(initialRequests.length)
    .filter((r: { mode: string }) => r.mode === 'success');
  assert.ok(
    successful[1].messages.some((m: { content: string }) =>
      m.content.includes('CANARY_ALPHA'),
    ),
  );
  assert.ok(
    !successful[2].messages.some((m: { content: string }) =>
      m.content.includes('CANARY_ALPHA'),
    ),
  );
  writeFileSync(
    join(root, 'canary-results.json'),
    JSON.stringify(
      {
        scope: 'six-case-matrix',
        matrixPassed: true,
        memoryIsolation: true,
        cases,
      },
      null,
      2,
    ),
  );
}
