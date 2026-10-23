import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileGraphToN8n } from '../../lib/workflow-graph/adapter/n8n-v1';
import type { WorkflowGraphV1 } from '../../lib/workflow-graph/types';
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
const graph = JSON.parse(
  readFileSync(join(root, 'graph.json'), 'utf8'),
) as WorkflowGraphV1;
graph.id = 'wf_n8n_graph_nokey';
graph.name = 'Clone explicit no-key rules';
graph.nodes.find((node) => node.id === 'node_model')!.config.credentialRef =
  'none';
graph.nodes.find((node) => node.id === 'node_agent')!.config.fallbackPolicy =
  'rules';
async function post(
  path: string,
  body: unknown,
  method: 'POST' | 'PUT' = 'POST',
) {
  const response = await fetch('http://127.0.0.1:3000' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secrets.admin}`,
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.text());
}
await post('/api/workflows', {
  id: graph.id,
  name: graph.name,
  action: 'publish',
  description: 'No model credential configured',
  steps: [
    {
      id: 'no-key',
      kind: 'compose',
      title: 'Rules',
      detail: 'Explicit degraded rules',
    },
  ],
  n8nWebhookUrl: 'http://127.0.0.1:5679/webhook/urtoris/wf_n8n_graph_nokey',
});
await post(
  `/api/workflows/${graph.id}/graph`,
  { graph, expectedRevision: 0 },
  'PUT',
);
await post(`/api/workflows/${graph.id}/graph/publish`, { expectedRevision: 1 });
const compiled = await compileGraphToN8n(graph, {
  workflowId: graph.id,
  version: 1,
});
assert.equal(compiled.ok, true);
const workflow = { ...compiled.workflow!, id: 'urtoris-graph-nokey' };
for (const node of workflow.nodes) {
  const ref =
    node.type === 'n8n-nodes-base.webhook'
      ? 'webhook'
      : node.name.endsWith('::execution-bound')
        ? 'internal'
        : null;
  if (ref)
    Object.assign(node, {
      credentials: {
        httpHeaderAuth: { id: `canary-${ref}`, name: `Canary ${ref}` },
      },
    });
}
const base = marker.workflows[0];
marker.workflows.push({
  ...base,
  externalWorkflowId: workflow.id,
  workflowId: graph.id,
  graphVersion: 1,
  compiledHash: compiled.compiledHash,
  triggerId: compiled.bindings.find(
    (binding) => binding.externalNodeName === base.triggerName,
  )!.externalNodeId,
  noModelRoutes: (compiled.workflow!.meta.urtoris as { noModelRoutes: unknown })
    .noModelRoutes,
});
writeFileSync(
  join(root, 'graph-runtime-clone.json'),
  JSON.stringify(marker, null, 2),
);
writeFileSync(
  join(root, 'nokey-workflow.json'),
  JSON.stringify(workflow, null, 2),
);
console.log(
  JSON.stringify({
    workflowId: graph.id,
    compiledHash: compiled.compiledHash,
    requiredCredentialRefs: compiled.requiredCredentialRefs,
  }),
);
