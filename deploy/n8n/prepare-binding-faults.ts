import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
if (process.env.URTORIS_CLONE_CANARY !== '1' || !root)
  throw new Error('CLONE_MARKER_REQUIRED');
const marker = JSON.parse(
  readFileSync(join(root, 'graph-runtime-clone.json'), 'utf8'),
);
if (marker.marker !== 'isolated-urtoris-graph-canary')
  throw new Error('INVALID_CLONE_MARKER');
const original = JSON.parse(readFileSync(join(root, 'workflow.json'), 'utf8'));
const workflows = [400, 401, 404, 409, 503].map((status) => {
  const copy = structuredClone(original);
  copy.id = `urtoris-graph-bind-${status}`;
  copy.name = `Clone binding ${status}`;
  for (const node of copy.nodes) {
    if (node.type === 'n8n-nodes-base.webhook')
      node.parameters.path = `urtoris/graph-bind-${status}`;
    if (node.name === marker.workflows[0].bindName)
      node.parameters.url = `http://127.0.0.1:5690/canary/binding-reject/${status}`;
  }
  return copy;
});
writeFileSync(join(root, 'binding-faults.json'), JSON.stringify(workflows));
console.log(JSON.stringify({ variants: workflows.map((wf) => wf.id) }));
