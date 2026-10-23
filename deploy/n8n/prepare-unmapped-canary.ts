/** Deliberate import drift fixture: one real node has no Graph binding. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
if (process.env.URTORIS_CLONE_CANARY !== '1' || !root)
  throw new Error('CLONE_MARKER_REQUIRED');
const marker = JSON.parse(
  readFileSync(join(root, 'graph-runtime-clone.json'), 'utf8'),
);
assert.equal(marker.marker, 'isolated-urtoris-graph-canary');
assert.ok(
  !marker.workflows.some(
    (wf: { externalWorkflowId: string }) =>
      wf.externalWorkflowId === 'urtoris-graph-unmapped',
  ),
);
const workflow = JSON.parse(readFileSync(join(root, 'workflow.json'), 'utf8'));
workflow.id = 'urtoris-graph-unmapped';
workflow.name = 'Clone unmapped drift test';
workflow.nodes.find(
  (node: { type: string }) => node.type === 'n8n-nodes-base.webhook',
).parameters.path = 'urtoris/graph-unmapped';
workflow.nodes.push({
  id: 'canary-unmapped',
  name: 'Clone extra unmapped node',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  parameters: { jsCode: 'return $input.all();' },
  position: [600, -200],
});
const guard = marker.workflows[0].guardName;
workflow.connections['Clone extra unmapped node'] = workflow.connections[guard];
workflow.connections[guard] = {
  main: [[{ node: 'Clone extra unmapped node', type: 'main', index: 0 }]],
};
writeFileSync(
  join(root, 'unmapped-workflow.json'),
  JSON.stringify(workflow, null, 2),
);
marker.workflows.push({
  ...marker.workflows[0],
  externalWorkflowId: workflow.id,
});
writeFileSync(
  join(root, 'graph-runtime-clone.json'),
  JSON.stringify(marker, null, 2),
);
console.log(
  JSON.stringify({
    prepared: true,
    externalWorkflowId: workflow.id,
    fixture: 'intentional-unmapped-import-drift',
  }),
);
