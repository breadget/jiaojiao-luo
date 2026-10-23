import { readFileSync, writeFileSync } from 'node:fs';
import { compileGraphToN8n } from '../../lib/workflow-graph/adapter/n8n-v1';
import type { WorkflowGraphV1 } from '../../lib/workflow-graph/types';
const graph = JSON.parse(
  readFileSync('tests/fixtures/canary-graph.json', 'utf8'),
) as WorkflowGraphV1;
const result = await compileGraphToN8n(graph, {
  workflowId: 'wf_canary',
  version: 1,
});
if (!result.ok) throw new Error(JSON.stringify(result.issues));
writeFileSync(
  'tests/fixtures/canary-compiled.n8n.json',
  JSON.stringify(result.workflow, null, 2) + '\n',
);
writeFileSync(
  'tests/fixtures/canary-compiled.meta.json',
  JSON.stringify(
    {
      graphHash: result.graphHash,
      compiledHash: result.compiledHash,
      bindings: result.bindings,
      requiredCredentialRefs: result.requiredCredentialRefs,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify({
    graphHash: result.graphHash,
    compiledHash: result.compiledHash,
  }),
);
