/** Prepare isolated local fixtures. Never reads an existing .dev.vars or production database. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compileGraphToN8n } from '../../lib/workflow-graph/adapter/n8n-v1';
import type { WorkflowGraphV1 } from '../../lib/workflow-graph/types';

const root = process.argv[2];
if (
  process.env.URTORIS_CLONE_CANARY !== '1' ||
  !root ||
  !isAbsolute(root) ||
  !/canary|clone/i.test(root)
)
  throw new Error('CLONE_ROOT_REQUIRED');
mkdirSync(root, { recursive: true });
const cloneRoot = realpathSync(root);
if (
  existsSync('.dev.vars') ||
  existsSync(join(root, 'graph-runtime-clone.json'))
)
  throw new Error('REFUSING_EXISTING_CONFIGURATION');
const graph = JSON.parse(
  readFileSync('tests/fixtures/canary-graph.json', 'utf8'),
) as WorkflowGraphV1;
graph.id = 'wf_n8n_graph_canary';
graph.name = 'Graph runtime clone canary';
graph.nodes = graph.nodes.filter(
  (node) => !['node_robot', 'node_http', 'node_tool'].includes(node.id),
);
const out = graph.nodes.find((node) => node.id === 'node_out')!;
out.id = 'node_high';
out.name = 'High response';
graph.nodes.push({
  ...structuredClone(out),
  id: 'node_normal',
  name: 'Normal response',
});
graph.nodes.find((node) => node.id === 'node_agent')!.config = {
  instructions:
    'Reply with a short answer. Remember user messages in this session.',
  prompt: '$json.question',
  maxIterations: 2,
  fallbackPolicy: 'error',
};
graph.nodes.find((node) => node.id === 'node_model')!.config = {
  provider: 'openai-compatible',
  model: 'qwen-canary-local',
  baseUrl: 'http://127.0.0.1:5690/v1',
};
graph.nodes.find((node) => node.id === 'node_route')!.config.expression =
  "$('U::node_trigger::input').first().json.urgency === 'high'";
const edge = (
  source: string,
  target: string,
  port = 'main.out',
  kind: 'main' | 'branch' = 'main',
) => ({
  id: `${source}_${port}_${target}`,
  source: { nodeId: source, portId: port },
  target: { nodeId: target, portId: 'main.in' },
  kind,
});
graph.edges = [
  ...graph.edges.filter(
    (item) => item.kind === 'memory' || item.kind === 'model',
  ),
  edge('node_trigger', 'node_agent'),
  edge('node_agent', 'node_route'),
  edge('node_route', 'node_high', 'branch.true', 'branch'),
  edge('node_route', 'node_normal', 'branch.false', 'branch'),
];
const compiled = await compileGraphToN8n(graph, {
  workflowId: graph.id,
  version: 1,
});
if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
const secrets = {
  internal: randomUUID(),
  webhook: randomUUID(),
  admin: randomUUID(),
  model: randomUUID(),
};
const workflow = structuredClone(
  compiled.workflow!,
) as typeof compiled.workflow & { id: string };
workflow!.id = 'urtoris-graph-canary';
for (const node of workflow!.nodes) {
  const credentialRef =
    node.type === 'n8n-nodes-base.webhook'
      ? 'webhook'
      : node.name.endsWith('::execution-bound')
        ? 'internal'
        : node.type.endsWith('.lmChatOpenAi')
          ? 'model'
          : null;
  if (credentialRef)
    Object.assign(node, {
      credentials: {
        [credentialRef === 'model' ? 'openAiApi' : 'httpHeaderAuth']: {
          id: `canary-${credentialRef}`,
          name: `Canary ${credentialRef}`,
        },
      },
    });
}
const json = (name: string, value: unknown) =>
  writeFileSync(join(cloneRoot, name), JSON.stringify(value, null, 2) + '\n');
json('graph-runtime-clone.json', {
  marker: 'isolated-urtoris-graph-canary',
  n8nVersion: '2.38.6',
  database: 'clone-data/.n8n/database.sqlite',
  n8nPackage: join(cloneRoot, 'node_modules/n8n/package.json'),
  eventsUrl: 'http://127.0.0.1:3000/api/n8n/events',
  workflows: [
    {
      externalWorkflowId: workflow!.id,
      workflowId: graph.id,
      graphVersion: 1,
      inputName: 'U::node_trigger::input',
      triggerName: 'U::node_trigger::primary',
      bindName: 'U::node_trigger::execution-bound',
      guardName: 'U::node_trigger::binding-guard',
      auxiliaryNames: compiled.bindings
        .filter((b) =>
          ['input', 'execution-bound', 'binding-guard', 'envelope'].includes(
            b.role,
          ),
        )
        .map((b) => b.externalNodeName),
    },
  ],
});
json('graph.json', graph);
json('workflow.json', workflow);
json('test-secrets.json', secrets);
json('credentials.json', [
  ...(['internal', 'webhook'] as const).map((key) => ({
    id: `canary-${key}`,
    name: `Canary ${key}`,
    type: 'httpHeaderAuth',
    data: { name: 'Authorization', value: `Bearer ${secrets[key]}` },
  })),
  {
    id: 'canary-model',
    name: 'Canary model',
    type: 'openAiApi',
    data: { apiKey: secrets.model, url: 'http://127.0.0.1:5690/v1' },
  },
]);
writeFileSync(
  '.dev.vars',
  `URTORIS_GRAPH_RUNTIME_CANARY=1\nURTORIS_INTERNAL_TOKEN=${secrets.internal}\nN8N_WEBHOOK_TOKEN=${secrets.webhook}\nURTORIS_ADMIN_TOKEN=${secrets.admin}\nN8N_BASE_URL=http://127.0.0.1:5679\n`,
);
mkdirSync('outputs', { recursive: true });
writeFileSync(
  'outputs/canary.wrangler.json',
  JSON.stringify({
    name: 'urtoris-graph-local-canary',
    compatibility_date: '2026-09-12',
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'site-creator-d1',
        database_id: '00000000-0000-4000-8000-000000000000',
      },
    ],
  }),
);
writeFileSync(
  'outputs/canary-migrations.sql',
  readdirSync('drizzle')
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .map((name) =>
      readFileSync(join('drizzle', name), 'utf8').replaceAll(
        '--> statement-breakpoint',
        '\n',
      ),
    )
    .join('\n'),
);
console.log(
  JSON.stringify({
    prepared: true,
    compiledHash: compiled.compiledHash,
    marker: 'isolated-urtoris-graph-canary',
  }),
);
