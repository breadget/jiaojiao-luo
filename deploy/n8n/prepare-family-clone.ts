/** Import copy of the existing 11-workflow family; no toolchain checkout is modified. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [root, generated] = process.argv.slice(2);
if (process.env.URTORIS_CLONE_CANARY !== '1' || !root || !generated)
  throw new Error('CLONE_MARKER_REQUIRED');
const marker = JSON.parse(
  readFileSync(join(root, 'graph-runtime-clone.json'), 'utf8'),
);
if (marker.marker !== 'isolated-urtoris-graph-canary')
  throw new Error('INVALID_CLONE_MARKER');
const secrets = JSON.parse(
  readFileSync(join(root, 'test-secrets.json'), 'utf8'),
);
const source = readFileSync(join(generated, 'all-workflows.json'), 'utf8');
const workflows = JSON.parse(
  source.replaceAll('http://127.0.0.1:5678', 'http://127.0.0.1:5679'),
);
const manifest = JSON.parse(
  readFileSync(join(generated, 'manifest.json'), 'utf8'),
);
if (workflows.length !== 11 || manifest.publishOrder.length !== 11)
  throw new Error('EXPECTED_ELEVEN_WORKFLOWS');
writeFileSync(
  join(root, 'family-workflows.json'),
  JSON.stringify(workflows, null, 2),
);
writeFileSync(
  join(root, 'family-import-order.json'),
  JSON.stringify(manifest.publishOrder),
);
writeFileSync(
  join(root, 'family-credentials.json'),
  JSON.stringify([
    {
      id: 'urtoris-internal-token',
      name: 'Urtoris Internal Token',
      type: 'httpHeaderAuth',
      data: { name: 'Authorization', value: `Bearer ${secrets.internal}` },
    },
    {
      id: 'urtoris-webhook-auth',
      name: 'Urtoris Webhook Bearer',
      type: 'httpHeaderAuth',
      data: { name: 'Authorization', value: `Bearer ${secrets.webhook}` },
    },
  ]),
);
console.log(
  JSON.stringify({
    count: workflows.length,
    sourceHash: createHash('sha256').update(source).digest('hex'),
    publishOrder: manifest.publishOrder,
  }),
);
