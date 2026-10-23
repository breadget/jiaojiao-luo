/** Writes only sanitized, asserted evidence. --final requires a complete 30-minute window. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compileGraphToN8n } from '../../lib/workflow-graph/adapter/n8n-v1';
import { findCredentialMaterial } from '../../lib/workflow-graph/payload';
import type { WorkflowGraphV1 } from '../../lib/workflow-graph/types';
import type {
  ExecutionSnapshot,
  RuntimeManifest,
} from '../../lib/workflow-graph/execution-data-events';
const root = process.argv[2];
if (process.env.URTORIS_CLONE_CANARY !== '1' || !root)
  throw new Error('CLONE_MARKER_REQUIRED');
const read = <T>(name: string): T =>
  JSON.parse(readFileSync(join(root, name), 'utf8')) as T;
const hash = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const marker = read<{
  marker: string;
  n8nVersion: string;
  n8nPackage: string;
  database: string;
  workflows: Array<RuntimeManifest & { compiledHash: string }>;
}>('graph-runtime-clone.json');
assert.equal(marker.marker, 'isolated-urtoris-graph-canary');
assert.equal(marker.n8nVersion, '2.38.6');
const secrets = read<Record<string, string>>('test-secrets.json');
const matrix = read<{
  matrixPassed: boolean;
  memoryIsolation: boolean;
  cases: Array<{
    name: string;
    requestId: string;
    executionId: string;
    status: string;
    events: number;
    nodes: unknown[];
  }>;
}>('canary-results.json');
assert.equal(matrix.matrixPassed, true);
assert.equal(matrix.memoryIsolation, true);
assert.equal(matrix.cases.length, 6);
const proofNames = [
  'binding-fault-results',
  'no-key-result',
  'unmapped-result',
  'runtime-protocol-result',
  'reconnect-result',
  'studio-result',
  'rollback-check-v2',
  'rollback-check-v3',
];
const proofs: Record<string, Record<string, unknown>> = {};
for (const name of proofNames) {
  proofs[name] = read<Record<string, unknown>>(name + '.json');
  assert.equal(proofs[name].passed, true, name);
}
const observation = read<{
  startedAt: number;
  elapsedMs: number;
  complete: boolean;
  pass: boolean;
  samples: Array<{ running: number; staleRunning: number }>;
}>('observation.json');
const complete =
  observation.complete && observation.pass && observation.elapsedMs >= 1800000;
if (process.argv.includes('--final'))
  assert.equal(complete, true, 'Full final observation is required');
const n8nRequire = createRequire(realpathSync(marker.n8nPackage));
const packages = [
  marker.n8nPackage,
  ...['n8n-core', 'n8n-nodes-base', '@n8n/n8n-nodes-langchain'].map((name) =>
    n8nRequire.resolve(name + '/package.json'),
  ),
];
const versions = packages.map((path) => {
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  return {
    name: pkg.name,
    version: pkg.version,
    packageJsonSha256: hash(path),
  };
});
const core = dirname(packages[1]);
const base = dirname(packages[2]);
const langchain = dirname(packages[3]);
const sourceFiles = [
  [
    dirname(realpathSync(marker.n8nPackage)),
    'dist/execution-lifecycle/execution-lifecycle-hooks.js',
  ],
  [core, 'dist/execution-engine/node-execution-context/supply-data-context.js'],
  [
    langchain,
    'dist/nodes/memory/MemoryBufferWindow/MemoryBufferWindow.node.js',
  ],
  [base, 'dist/nodes/Webhook/Webhook.node.js'],
];
const sources = sourceFiles.map(([folder, path]) => ({
  path,
  sha256: hash(join(folder, path)),
}));
const databasePath = realpathSync(join(root, marker.database));
assert.ok(!relative(realpathSync(root), databasePath).startsWith('..'));
const db = new DatabaseSync(databasePath, { readOnly: true });
const parse = n8nRequire('flatted').parse as (
  text: string,
) => ExecutionSnapshot['data'];
const family = read<string[]>('family-import-order.json');
assert.equal(family.length, 11);
const activeFamily = family.map((id) => {
  const row = db
    .prepare('SELECT id, activeVersionId FROM workflow_entity WHERE id=?')
    .get(id) as { id: string; activeVersionId: string };
  assert.ok(row?.activeVersionId, `Inactive family workflow: ${id}`);
  return row;
});
const stale = db
  .prepare(
    "SELECT count(*) n FROM execution_entity WHERE status='running' AND stoppedAt IS NULL",
  )
  .get()!;
assert.equal(stale.n, 0);
const verifiedInputs = [];
const nodeErrors = [];
for (const entry of matrix.cases) {
  const row = db
    .prepare(
      'SELECT e.status, d.data, d.workflowData FROM execution_entity e JOIN execution_data d ON d.executionId=e.id WHERE e.id=?',
    )
    .get(entry.executionId) as {
    status: string;
    data: string;
    workflowData: string;
  };
  assert.equal(row.status, entry.status === 'completed' ? 'success' : 'error');
  const data = parse(row.data).resultData!.runData!;
  const input = data[marker.workflows[0].inputName][0].data!.main[0]![0].json!;
  assert.equal(input.requestId, entry.requestId);
  assert.equal(input.workflowId, marker.workflows[0].workflowId);
  assert.equal(input.__urtorisExecutionId, entry.executionId);
  assert.equal(input.channel, 'web');
  assert.equal(typeof input.sessionId, 'string');
  assert.ok(String(input.sessionId).trim());
  assert.equal(typeof input.question, 'string');
  assert.ok(input.question);
  assert.equal(
    input.urgency,
    ['high', 'wrong-key', 'network'].includes(entry.name) ? 'high' : 'normal',
  );
  const workflow = JSON.parse(
    row.workflowData,
  ) as ExecutionSnapshot['workflowData'];
  const memory = workflow.nodes.find((node) =>
    node.type.endsWith('.memoryBufferWindow'),
  ) as { parameters?: { sessionKey?: string } } | undefined;
  assert.ok(
    memory?.parameters?.sessionKey?.includes(
      "$('U::node_trigger::input').first().json.sessionId",
    ),
  );
  verifiedInputs.push({
    case: entry.name,
    executionId: entry.executionId,
    requestIdMatches: true,
    sessionKeyNonempty: true,
    questionPropagated: true,
    channel: input.channel,
    urgency: input.urgency,
  });
  const response = await fetch(
    `http://127.0.0.1:3000/api/runs/${entry.requestId}/telemetry`,
    { headers: { Authorization: `Bearer ${secrets.admin}` } },
  );
  assert.equal(response.status, 200);
  const page = (await response.json()) as {
    nodes: Array<{
      nodeId: string;
      error?: { code?: string; message: string; detail?: string };
    }>;
    events: unknown[];
  };
  for (const secret of Object.values(secrets))
    assert.ok(
      !JSON.stringify(page).includes(secret),
      'Telemetry leaked local credential',
    );
  if (entry.status === 'failed') {
    const error = page.nodes.find(
      (node) => node.nodeId === 'node_model',
    )!.error!;
    assert.equal(
      error.code,
      entry.name === 'network' ? 'NETWORK_ERROR' : 'LLM_ERROR',
    );
    assert.ok(error.message);
    assert.ok(error.detail);
    nodeErrors.push({ case: entry.name, error });
  }
}
db.close();
const graph = read<WorkflowGraphV1>('graph.json');
const compiled = await compileGraphToN8n(graph, {
  workflowId: graph.id,
  version: marker.workflows[0].graphVersion,
});
assert.equal(compiled.ok, true);
assert.equal(compiled.compiledHash, marker.workflows[0].compiledHash);
const again = await compileGraphToN8n(graph, {
  workflowId: graph.id,
  version: marker.workflows[0].graphVersion,
});
assert.equal(compiled.compiledJson, again.compiledJson);
assert.equal(findCredentialMaterial(compiled.workflow), null);
for (const secret of Object.values(secrets))
  assert.ok(!compiled.compiledJson!.includes(secret));
const golden = JSON.parse(
  readFileSync('tests/fixtures/canary-compiled.meta.json', 'utf8'),
);
const validation = JSON.parse(
  readFileSync('outputs/final-validation.json', 'utf8'),
) as Array<{ command: string; exitCode: number }>;
assert.equal(validation.length, 4);
for (const check of validation) assert.equal(check.exitCode, 0, check.command);
const report = {
  scope:
    'Real n8n 2.38.6 + isolated local SQLite/workerd D1 + local OpenAI-compatible substitute + real Studio browser',
  complete,
  baseline: '0f14948b0e6cf74aa85edc514e6bed76a1b8d005',
  branch: 'codex/graph-runtime-canary',
  generatedAt: new Date().toISOString(),
  architecture:
    'B: saved execution-data forwarder with synchronous deterministic prebind gate',
  runtime: { node: process.version, packages: versions, sources },
  artifacts: {
    goldenCompiledHash: golden.compiledHash,
    goldenGraphHash: golden.graphHash,
    goldenFileSha256: hash('tests/fixtures/canary-compiled.n8n.json'),
    graphCompiledHash: compiled.compiledHash,
    graphVersion: marker.workflows[0].graphVersion,
    noKeyCompiledHash: marker.workflows.find(
      (wf) => wf.externalWorkflowId === 'urtoris-graph-nokey',
    )!.compiledHash,
    importCopySha256: hash(join(root, 'workflow.json')),
    noCredentials: true,
    deterministic: true,
  },
  family: {
    count: activeFamily.length,
    active: activeFamily,
    importedCopySha256: hash(join(root, 'family-workflows.json')),
    scope:
      'Import and activation verified; Graph matrix does not certify all legacy business workflows.',
  },
  matrix,
  verifiedInputs,
  nodeErrors,
  proofs,
  observation: {
    startedAt: observation.startedAt,
    elapsedMs: observation.elapsedMs,
    complete: observation.complete,
    pass: observation.pass,
    samples: observation.samples.length,
    maxStaleRunning: Math.max(
      ...observation.samples.map((sample) => sample.staleRunning),
    ),
    finalRunning: observation.samples.at(-1)!.running,
  },
  currentRunning: Number(stale.n),
  validation,
  validationLogs: ['test', 'tsc', 'oxlint', 'build'].map((name) => ({
    file: `outputs/final-${name}.log`,
    sha256: hash(`outputs/final-${name}.log`),
  })),
  productionEnabled: false,
  deployLocked: true,
  remainingBlockers: complete
    ? []
    : ['Final uninterrupted 30-minute observation incomplete'],
  outsideValidatedScope: [
    'No production database, production n8n or production key accessed.',
    'No offline production backup or source-version configuration was provided; production data upgrade remains unverified.',
    'Cloud DashScope was not called. Local substitute covers success, 401, TCP disconnect and malformed JSON.',
    'One pre-existing optional live Qwen key test remains skipped; the real local n8n canary was executed.',
    'Forwarder replays finalized SQLite snapshots; live low-latency streaming, queue/HA and persistent multi-worker Memory are not implemented.',
  ],
};
const text = JSON.stringify(report, null, 2) + '\n';
for (const secret of Object.values(secrets)) assert.ok(!text.includes(secret));
mkdirSync('docs/evidence', { recursive: true });
writeFileSync(
  process.argv.includes('--final')
    ? 'docs/evidence/graph-runtime-canary.json'
    : join(root, 'evidence-preview.json'),
  text,
);
console.log(
  JSON.stringify({
    complete,
    cases: matrix.cases.length,
    observationMs: observation.elapsedMs,
    graphCompiledHash: compiled.compiledHash,
  }),
);
