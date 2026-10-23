import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
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
const requireN8n = createRequire(realpathSync(marker.n8nPackage));
const parse = requireN8n('flatted').parse;
const db = new DatabaseSync(join(root, marker.database), { readOnly: true });
const results = [];
try {
  for (const status of [400, 401, 404, 409, 503]) {
    const requestId = randomUUID();
    const response = await fetch(
      `http://127.0.0.1:5679/webhook/urtoris/graph-bind-${status}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secrets.webhook}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requestId,
          sessionId: randomUUID(),
          workflowId: marker.workflows[0].workflowId,
          question: 'must not call model',
          urgency: 'high',
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
    assert.ok(response.status >= 400);
    await response.text();
    await setTimeout(500);
    const row = db
      .prepare(`SELECT e.id,e.status,d.data FROM execution_entity e JOIN execution_data d ON d.executionId=e.id
      WHERE e.workflowId=? ORDER BY e.id DESC LIMIT 1`)
      .get(`urtoris-graph-bind-${status}`)!;
    assert.equal(row.status, 'error');
    const data = parse(row.data as string);
    const nodes = Object.keys(data.resultData.runData);
    assert.ok(nodes.includes(marker.workflows[0].bindName));
    assert.ok(nodes.includes(marker.workflows[0].guardName));
    assert.ok(
      !nodes.some((name) =>
        /node_agent|node_model|node_memory|node_robot|node_tool|node_http/.test(
          name,
        ),
      ),
    );
    results.push({
      bindingStatus: status,
      executionId: String(row.id),
      n8nStatus: row.status,
      nodes,
    });
    console.log(JSON.stringify(results.at(-1)));
  }
  writeFileSync(
    join(root, 'binding-fault-results.json'),
    JSON.stringify({ passed: true, results }, null, 2),
  );
} finally {
  db.close();
}
