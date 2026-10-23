/** --begin with forwarder stopped, --finish after restarting it. Real HTTP/SQLite only. */
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
type Page = {
  nextSeq: number;
  eventsComplete: boolean;
  run: { status: string; executionId: string };
  events: Array<{ seq: number; eventType: string }>;
};
const page = async (requestId: string, cursor = 0): Promise<Page> =>
  (
    await fetch(
      `http://127.0.0.1:3000/api/runs/${requestId}/telemetry?afterSeq=${cursor}`,
      { headers },
    )
  ).json() as Promise<Page>;
const path = join(root, 'reconnect-result.json');
if (process.argv.includes('--begin')) {
  const requestId = crypto.randomUUID();
  const response = await fetch('http://127.0.0.1:3000/api/runs', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      requestId,
      sessionId: crypto.randomUUID(),
      workflowId: 'wf_n8n_graph_canary',
      message: 'Forwarder offline canary',
      input: { urgency: 'high' },
    }),
  });
  const result = (await response.json()) as { envelope: { success: boolean } };
  assert.equal(result.envelope.success, true);
  await setTimeout(2000);
  const first = await page(requestId);
  assert.equal(first.eventsComplete, false);
  assert.equal(first.run.status, 'running');
  assert.deepEqual(
    first.events.map((event) => event.eventType),
    ['execution.bound'],
  );
  writeFileSync(
    path,
    JSON.stringify({ requestId, passed: false, first }, null, 2),
  );
  console.log(
    JSON.stringify({
      requestId,
      noFalseSuccess: true,
      events: first.events.length,
    }),
  );
} else if (process.argv.includes('--finish')) {
  const report = JSON.parse(readFileSync(path, 'utf8')) as {
    requestId: string;
    first: Page;
  };
  let recovered!: Page;
  for (let i = 0; i < 30; i++) {
    recovered = await page(report.requestId, report.first.nextSeq);
    if (recovered.eventsComplete) break;
    await setTimeout(1000);
  }
  assert.equal(recovered.eventsComplete, true);
  assert.equal(recovered.run.status, 'completed');
  assert.equal(recovered.events.at(-1)!.eventType, 'run.completed');
  const full = await page(report.requestId);
  assert.deepEqual(
    [...report.first.events, ...recovered.events].map((e) => e.seq),
    full.events.map((e) => e.seq),
  );
  assert.equal(new Set(full.events.map((e) => e.seq)).size, full.events.length);
  assert.equal(
    (await page(report.requestId, recovered.nextSeq)).events.length,
    0,
  );
  writeFileSync(
    path,
    JSON.stringify(
      {
        passed: true,
        requestId: report.requestId,
        executionId: recovered.run.executionId,
        offlineStatus: report.first.run.status,
        offlineEvents: report.first.events.length,
        recoveredEvents: recovered.events.length,
        terminal: recovered.events.at(-1)!.eventType,
        noDuplicatesOrLoss: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, noDuplicatesOrLoss: true }));
} else throw new Error('EXPECTED_BEGIN_OR_FINISH');
