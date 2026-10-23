/** Replays actual saved binding and probes rejected packets against local workerd D1. */
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  executionDataEvents,
  type ExecutionSnapshot,
} from '../../lib/workflow-graph/execution-data-events';
const root = process.argv[2];
if (process.env.URTORIS_CLONE_CANARY !== '1' || !root)
  throw new Error('CLONE_MARKER_REQUIRED');
const marker = JSON.parse(
  readFileSync(join(root, 'graph-runtime-clone.json'), 'utf8'),
);
assert.equal(marker.marker, 'isolated-urtoris-graph-canary');
const path = realpathSync(join(root, marker.database));
assert.ok(!relative(realpathSync(root), path).startsWith('..'));
const secrets = JSON.parse(
  readFileSync(join(root, 'test-secrets.json'), 'utf8'),
);
const cases = JSON.parse(
  readFileSync(join(root, 'canary-results.json'), 'utf8'),
).cases;
const selected = cases.find((entry: { name: string }) => entry.name === 'high');
const db = new DatabaseSync(path, { readOnly: true });
const row = db
  .prepare(
    'SELECT e.id, e.workflowId, e.status, e.stoppedAt, d.data, d.workflowData FROM execution_entity e JOIN execution_data d ON d.executionId=e.id WHERE e.id=?',
  )
  .get(selected.executionId) as Record<string, string>;
db.close();
const require = createRequire(realpathSync(marker.n8nPackage));
const snapshot: ExecutionSnapshot = {
  id: String(row.id),
  workflowId: row.workflowId,
  status: row.status,
  stoppedAt: Date.parse(row.stoppedAt + 'Z'),
  data: require('flatted').parse(row.data),
  workflowData: JSON.parse(row.workflowData),
};
const events = executionDataEvents(snapshot, marker.workflows[0]);
assert.ok(events.length > 1);
const binding = events[0];
const statuses: Record<string, number> = {};
async function probe(
  name: string,
  event: unknown,
  expected: number,
  token = secrets.internal,
) {
  const response = await fetch('http://127.0.0.1:3000/api/n8n/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(event),
  });
  statuses[name] = response.status;
  assert.equal(response.status, expected);
  if (expected === 200) {
    const body = (await response.json()) as {
      ok: boolean;
      bound: boolean;
      duplicate: boolean;
    };
    assert.equal(body.ok, true);
    assert.equal(body.bound, true);
    assert.equal(body.duplicate, true);
  }
}
await probe('duplicateBinding', binding, 200);
await probe('unauthorized', binding, 401, 'deliberately-wrong-local-token');
await probe('invalidRequest', { ...binding, requestId: '' }, 400);
await probe(
  'unknownWorkflow',
  {
    ...binding,
    executionId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    workflowId: 'wf_n8n_unknown_clone',
  },
  404,
);
await probe(
  'executionConflict',
  { ...binding, requestId: crypto.randomUUID() },
  409,
);
await probe(
  'workflowConflict',
  { ...binding, workflowId: 'wf_n8n_other_clone' },
  409,
);
await probe(
  'sessionConflict',
  { ...binding, sessionId: crypto.randomUUID() },
  409,
);
await probe('versionConflict', { ...binding, graphVersion: 1000 }, 409);
await probe(
  'terminalLateStart',
  {
    ...binding,
    sourceSeq: events.length,
    eventType: 'node.started',
    node: 'U::node_agent::primary',
    at: Date.now(),
  },
  409,
);
type Page = {
  nextSeq: number;
  events: Array<{ seq: number; eventType: string }>;
  nodes: Array<{ nodeId: string; state: string }>;
  run: { status: string };
};
const get = async (cursor: number, limit = 3): Promise<Page> =>
  (
    await fetch(
      `http://127.0.0.1:3000/api/runs/${binding.requestId}/telemetry?afterSeq=${cursor}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${secrets.admin}` } },
    )
  ).json() as Promise<Page>;
const full = await get(0, 100);
assert.equal(full.run.status, 'completed');
assert.equal(
  full.nodes.find((node) => node.nodeId === 'node_agent')!.state,
  'success',
);
let cursor = 0;
const seen = [];
for (let i = 0; i < 10; i++) {
  const page = await get(cursor);
  seen.push(...page.events.map((event) => event.seq));
  cursor = page.nextSeq;
  if (!page.events.length) break;
}
assert.deepEqual(
  seen,
  full.events.map((event) => event.seq),
);
assert.equal(new Set(seen).size, seen.length);
assert.equal(full.events[0].eventType, 'execution.bound');
assert.equal(full.events.at(-1)!.eventType, 'run.completed');
const report = {
  passed: true,
  executionId: binding.executionId,
  statuses,
  cursorEvents: seen.length,
  noDuplicatesOrLoss: true,
  lateStartDidNotRegressSuccess: true,
};
writeFileSync(
  join(root, 'runtime-protocol-result.json'),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
