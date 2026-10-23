import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
const root = process.argv[2];
if (process.env.URTORIS_CLONE_CANARY !== '1' || !root)
  throw new Error('CLONE_MARKER_REQUIRED');
assert.equal(
  JSON.parse(readFileSync(join(root, 'graph-runtime-clone.json'), 'utf8'))
    .marker,
  'isolated-urtoris-graph-canary',
);
const secrets = JSON.parse(
  readFileSync(join(root, 'test-secrets.json'), 'utf8'),
);
const headers = {
  Authorization: `Bearer ${secrets.admin}`,
  Origin: 'http://127.0.0.1:3000',
  'Content-Type': 'application/json',
};
const state = (await (
  await fetch('http://127.0.0.1:3000/api/state', { headers })
).json()) as {
  workflows: Array<{
    id: string;
    n8nWebhookUrl: string;
    publishedSteps: unknown[];
  }>;
};
const workflow = state.workflows.find((wf) => wf.id === 'wf_n8n_graph_canary')!;
async function bind(url: string) {
  const response = await fetch('http://127.0.0.1:3000/api/workflows', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...workflow,
      steps: workflow.publishedSteps,
      action: 'publish',
      n8nWebhookUrl: url,
    }),
  });
  assert.equal(response.status, 200, await response.text());
}
try {
  await bind('http://127.0.0.1:5679/webhook/urtoris/graph-unmapped');
  const requestId = crypto.randomUUID();
  const result = (await (
    await fetch('http://127.0.0.1:3000/api/runs', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requestId,
        sessionId: crypto.randomUUID(),
        workflowId: workflow.id,
        message: 'Unmapped real node canary',
        input: { urgency: 'high' },
      }),
    })
  ).json()) as { envelope: { success: boolean } };
  assert.equal(result.envelope.success, true);
  let page!: {
    eventsComplete: boolean;
    run: { executionId: string };
    unmappedNodes: unknown[];
    events: Array<{
      eventType: string;
      externalNode: string;
      internalNodeId: string | null;
    }>;
  };
  for (let i = 0; i < 30; i++) {
    page = (await (
      await fetch(`http://127.0.0.1:3000/api/runs/${requestId}/telemetry`, {
        headers,
      })
    ).json()) as typeof page;
    if (page.eventsComplete) break;
    await setTimeout(1000);
  }
  assert.equal(page.eventsComplete, true);
  assert.ok(
    JSON.stringify(page.unmappedNodes).includes('Clone extra unmapped node'),
  );
  writeFileSync(
    join(root, 'unmapped-result.json'),
    JSON.stringify(
      {
        passed: true,
        requestId,
        executionId: page.run.executionId,
        unmappedNodes: page.unmappedNodes,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ passed: true, unmappedNodes: page.unmappedNodes }),
  );
} finally {
  await bind(workflow.n8nWebhookUrl);
}
