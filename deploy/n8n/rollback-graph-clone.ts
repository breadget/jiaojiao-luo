/** Run only while the clone n8n and forwarder are stopped; restart both after switching. */
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
const [root, versionText, n8nVersionId] = process.argv.slice(2);
if (process.env.URTORIS_CLONE_CANARY !== '1' || !root || !isAbsolute(root))
  throw new Error('CLONE_MARKER_REQUIRED');
const clone = realpathSync(root);
const markerPath = join(clone, 'graph-runtime-clone.json');
const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
assert.equal(marker.marker, 'isolated-urtoris-graph-canary');
assert.equal(marker.n8nVersion, '2.38.6');
assert.equal(
  JSON.parse(readFileSync(marker.n8nPackage, 'utf8')).version,
  '2.38.6',
);
const database = realpathSync(join(clone, marker.database));
assert.ok(!relative(clone, database).startsWith('..'));
const db = new DatabaseSync(database, { readOnly: true });
const manifest = marker.workflows[0];
const history = db
  .prepare(
    'SELECT nodes FROM workflow_history WHERE workflowId=? AND versionId=?',
  )
  .get(manifest.externalWorkflowId, n8nVersionId) as
  | { nodes: string }
  | undefined;
assert.ok(history, 'Exact workflow/version must exist in clone history');
const nodes = JSON.parse(history.nodes);
const bound = nodes.find(
  (node: { name: string }) => node.name === manifest.bindName,
);
assert.ok(
  bound.parameters.jsonBody.includes(`graphVersion: ${Number(versionText)},`),
  'Site and n8n graph versions must agree',
);
const trigger = nodes.find(
  (node: { name: string }) => node.name === manifest.triggerName,
);
assert.ok(
  trigger.webhookId,
  'Rollback target must have the verified webhook ID',
);
db.close();
try {
  await fetch('http://127.0.0.1:5679/healthz', {
    signal: AbortSignal.timeout(1500),
  });
  throw new Error('STOP_CLONE_BEFORE_SWITCH');
} catch (cause) {
  if (cause instanceof Error && cause.message === 'STOP_CLONE_BEFORE_SWITCH')
    throw cause;
}
const secrets = JSON.parse(
  readFileSync(join(clone, 'test-secrets.json'), 'utf8'),
);
const headers = {
  Authorization: `Bearer ${secrets.admin}`,
  Origin: 'http://127.0.0.1:3000',
  'Content-Type': 'application/json',
};
const url = `http://127.0.0.1:3000/api/workflows/${manifest.workflowId}/graph/versions`;
const versions = (await (await fetch(url, { headers })).json()) as {
  versions: Array<{ id: string; version: number; compiledHash: string }>;
};
const target = versions.versions.find(
  (item) => item.version === Number(versionText),
);
assert.ok(target, 'Site history version must exist');
const result = spawnSync(
  process.execPath,
  [
    join(clone, 'node_modules/n8n/bin/n8n'),
    'publish:workflow',
    `--id=${manifest.externalWorkflowId}`,
    `--versionId=${n8nVersionId}`,
  ],
  {
    env: {
      ...process.env,
      N8N_USER_FOLDER: join(clone, 'clone-data'),
      DB_TYPE: 'sqlite',
      DB_SQLITE_DATABASE: 'database.sqlite',
    },
    encoding: 'utf8',
    windowsHide: true,
  },
);
assert.equal(
  result.status,
  0,
  'Clone publish CLI failed; keep services stopped and inspect local log',
);
const response = await fetch(`${url}/${target.id}/rollback`, {
  method: 'POST',
  headers,
  body: '{}',
});
assert.equal(response.status, 200);
const acknowledgment = (await response.json()) as { adapterLocked: boolean };
assert.equal(acknowledgment.adapterLocked, true);
manifest.graphVersion = target.version;
manifest.compiledHash = target.compiledHash;
manifest.triggerId = trigger.id;
writeFileSync(markerPath, JSON.stringify(marker, null, 2));
writeFileSync(
  join(clone, `rollback-switch-v${target.version}.json`),
  JSON.stringify(
    {
      graphVersion: target.version,
      n8nVersionId,
      compiledHash: target.compiledHash,
      adapterLocked: true,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    switched: true,
    graphVersion: target.version,
    n8nVersionId,
    restartRequired: true,
  }),
);
