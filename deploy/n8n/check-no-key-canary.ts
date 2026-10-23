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
const requestId = crypto.randomUUID();
const before = (await (
  await fetch('http://127.0.0.1:5690/canary/requests')
).json()) as unknown[];
const response = await fetch('http://127.0.0.1:3000/api/runs', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${secrets.admin}`,
    Origin: 'http://127.0.0.1:3000',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    workflowId: 'wf_n8n_graph_nokey',
    requestId,
    sessionId: crypto.randomUUID(),
    message: 'No model configured',
    input: { urgency: 'high' },
  }),
});
assert.equal(response.status, 200);
const result = (await response.json()) as {
  envelope: { success: boolean; mode: string; degraded: boolean };
};
assert.equal(result.envelope.success, true);
assert.equal(result.envelope.mode, 'rules');
assert.equal(result.envelope.degraded, true);
const after = (await (
  await fetch('http://127.0.0.1:5690/canary/requests')
).json()) as unknown[];
assert.equal(after.length, before.length, 'no-key must not call model');
let telemetry!: {
  eventsComplete: boolean;
  run: { status: string; executionId: string };
  nodes: Array<{ nodeId: string; state: string }>;
};
for (let i = 0; i < 20; i++) {
  telemetry = (await (
    await fetch(`http://127.0.0.1:3000/api/runs/${requestId}/telemetry`, {
      headers: { Authorization: `Bearer ${secrets.admin}` },
    })
  ).json()) as typeof telemetry;
  if (telemetry.eventsComplete) break;
  await setTimeout(1000);
}
assert.equal(telemetry.eventsComplete, true);
assert.equal(telemetry.run.status, 'completed');
for (const nodeId of ['node_model', 'node_memory'])
  assert.equal(
    telemetry.nodes.find((node) => node.nodeId === nodeId)!.state,
    'skipped',
  );
const report = {
  passed: true,
  requestId,
  executionId: telemetry.run.executionId,
  mode: 'rules',
  degraded: true,
  modelCalls: after.length - before.length,
  nodes: telemetry.nodes,
};
writeFileSync(
  join(root, 'no-key-result.json'),
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify({
    passed: true,
    requestId,
    mode: 'rules',
    degraded: true,
    modelCalls: 0,
  }),
);
