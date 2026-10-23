/** Rebuilds only the import copy, preserving secrets and immutable Graph input. */
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
if (marker.marker !== 'isolated-urtoris-graph-canary')
  throw new Error('INVALID_CLONE_MARKER');
const manifest = marker.workflows[0];
const graph = JSON.parse(
  readFileSync(join(root, 'graph.json'), 'utf8'),
) as WorkflowGraphV1;
const compiled = await compileGraphToN8n(graph, {
  workflowId: manifest.workflowId,
  version: manifest.graphVersion,
});
if (!compiled.ok) throw new Error('COMPILE_FAILED');
if (manifest.compiledHash && compiled.compiledHash !== manifest.compiledHash)
  throw new Error('PUBLISHED_HASH_MISMATCH');
const workflow = { ...compiled.workflow!, id: manifest.externalWorkflowId };
for (const node of workflow.nodes) {
  const ref =
    node.type === 'n8n-nodes-base.webhook'
      ? 'webhook'
      : node.name === manifest.bindName
        ? 'internal'
        : node.type.endsWith('.lmChatOpenAi')
          ? 'model'
          : null;
  if (ref)
    Object.assign(node, {
      credentials: {
        [ref === 'model' ? 'openAiApi' : 'httpHeaderAuth']: {
          id: `canary-${ref}`,
          name: `Canary ${ref}`,
        },
      },
    });
}
writeFileSync(join(root, 'workflow.json'), JSON.stringify(workflow, null, 2));
manifest.triggerId = compiled.bindings.find(
  (binding) => binding.externalNodeName === manifest.triggerName,
)!.externalNodeId;
manifest.noModelRoutes = (
  compiled.workflow!.meta.urtoris as { noModelRoutes: unknown }
).noModelRoutes;
writeFileSync(
  join(root, 'graph-runtime-clone.json'),
  JSON.stringify(marker, null, 2),
);
console.log(JSON.stringify({ compiledHash: compiled.compiledHash }));
