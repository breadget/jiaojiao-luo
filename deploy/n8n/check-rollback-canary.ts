import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
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
const headers = {
  Authorization: `Bearer ${secrets.admin}`,
  Origin: 'http://127.0.0.1:3000',
  'Content-Type': 'application/json',
};
await fetch('http://127.0.0.1:5690/canary/control', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{"mode":"success"}',
});
const results = [];
for (const urgency of ['high', 'normal']) {
  const requestId = crypto.randomUUID();
  const response = await fetch('http://127.0.0.1:3000/api/runs', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      requestId,
      sessionId: crypto.randomUUID(),
      workflowId: marker.workflows[0].workflowId,
      message: 'Rollback canary',
      input: { urgency },
    }),
  });
  const result = (await response.json()) as {
    envelope: { success: boolean; data: { outputNodeId: string } };
  };
  assert.equal(result.envelope.success, true);
  assert.equal(result.envelope.data.outputNodeId, `node_${urgency}`);
  let page!: {
    eventsComplete: boolean;
    boundVersion: number;
    run: { executionId: string };
    events: Array<{ eventType: string }>;
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
  assert.equal(page.boundVersion, marker.workflows[0].graphVersion);
  assert.equal(page.events[0].eventType, 'execution.bound');
  assert.equal(page.events.at(-1)!.eventType, 'run.completed');
  results.push({
    urgency,
    requestId,
    executionId: page.run.executionId,
    graphVersion: page.boundVersion,
  });
}
writeFileSync(
  join(root, `rollback-check-v${marker.workflows[0].graphVersion}.json`),
  JSON.stringify({ passed: true, results }, null, 2),
);
console.log(JSON.stringify({ passed: true, results }));
