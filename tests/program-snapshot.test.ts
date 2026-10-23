import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { env } from './helpers/cloudflare-workers-stub';
import { createGraphNode } from '@/lib/workflow-graph/registry';
import { compileGraphToProgram } from '@/lib/workflow-graph/adapter/program';
import { createCourseProgramGraph } from '@/lib/workflow-program/templates';
import {
  PROGRAM_SNAPSHOT_MAX_BYTES,
  type ProgramJob,
} from '@/lib/workflow-program/types';
import {
  fetchProgramJob,
  ProgramClientError,
} from '@/lib/server/workflow-program-client';
import { ProgramExecutor } from '@/services/workflow-program/executor';
import { ProgramStorage } from '@/services/workflow-program/storage';
import { createProgramHttpServer } from '@/services/workflow-program/server';
import {
  MAX_SNAPSHOT_BYTES,
  ProgramServiceError,
} from '@/services/workflow-program/safety';

const token = 'program-snapshot-internal-token-32-characters';
const id = `program_${'a'.repeat(32)}`;
const pause = (milliseconds: number) =>
  new Promise<void>((done) => setTimeout(done, milliseconds));

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}

function configure(origin: string) {
  const previous = {
    url: env.WORKFLOW_PROGRAM_URL,
    token: env.WORKFLOW_PROGRAM_TOKEN,
  };
  env.WORKFLOW_PROGRAM_URL = origin;
  env.WORKFLOW_PROGRAM_TOKEN = token;
  return () => {
    env.WORKFLOW_PROGRAM_URL = previous.url;
    env.WORKFLOW_PROGRAM_TOKEN = previous.token;
  };
}

test('a legal 40-node program keeps its real completed snapshot readable across worker and main client', async () => {
  const graph = createCourseProgramGraph('snapshot_size', { withModel: false });
  const node = (
    nodeId: string,
    type: 'trigger' | 'transform' | 'output',
    config: Record<string, unknown> = {},
  ) =>
    createGraphNode(type, { x: 0, y: 0 }, { id: nodeId, name: nodeId, config });
  graph.nodes = [
    node('start', 'trigger'),
    ...Array.from({ length: 38 }, (_, index) =>
      node(`transform_${index}`, 'transform', {
        mapping: { text: index === 0 ? 'x'.repeat(16_000) : '$json.text' },
      }),
    ),
    node('output', 'output', { text: '$json.text' }),
  ];
  graph.entryNodeIds = ['start'];
  graph.edges = graph.nodes.slice(1).map((next, index) => ({
    id: `edge_${index}`,
    kind: 'main',
    source: { nodeId: graph.nodes[index].id, portId: 'main.out' },
    target: { nodeId: next.id, portId: 'main.in' },
  }));
  const compiled = await compileGraphToProgram(graph, {
    workflowId: graph.id,
    version: 1,
  });
  assert.equal(compiled.ok, true, JSON.stringify(compiled.issues));
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), 'program-snapshot-test-'),
  );
  const storage = new ProgramStorage(directory);
  const executor = new ProgramExecutor({ storage });
  const server = createProgramHttpServer({ executor, storage, token });
  const restore = configure(await listen(server));
  try {
    await executor.init();
    await executor.submit({
      id,
      workflowId: graph.id,
      workflowName: graph.name,
      workflowVersion: 1,
      versionId: 'version_snapshot_size',
      plan: compiled.plan!,
      input: { message: 'input' },
      llm: {
        provider: 'custom',
        apiKey: '',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'unused',
        reasoningEffort: 'auto',
      },
    });
    const deadline = Date.now() + 10_000;
    while (!executor.get(id)?.finishedAt && Date.now() < deadline)
      await pause(10);
    const local = executor.get(id)!;
    assert.equal(local.status, 'completed');
    const bytes = Buffer.byteLength(JSON.stringify(local));
    assert.ok(
      bytes > 1024 * 1024,
      'the regression must exceed the former main-client cap',
    );
    assert.ok(bytes < PROGRAM_SNAPSHOT_MAX_BYTES);
    assert.equal(MAX_SNAPSHOT_BYTES, PROGRAM_SNAPSHOT_MAX_BYTES);
    const fetched = await fetchProgramJob(id);
    assert.equal(fetched.status, 'completed');
    assert.equal(Object.keys(fetched.nodes).length, 40);
    assert.equal(fetched.result?.text, 'x'.repeat(16_000));
    assert.ok(
      Object.values(fetched.nodes).every(
        (snapshot) => snapshot.state === 'success',
      ),
    );

    const stored = (await storage.read(id))!;
    stored.job.result!.text = 'x'.repeat(PROGRAM_SNAPSHOT_MAX_BYTES);
    await assert.rejects(
      storage.write(stored),
      (error: unknown) =>
        error instanceof ProgramServiceError &&
        error.code === 'OUTPUT_TOO_LARGE',
    );
    assert.equal((await storage.read(id))!.job.result!.text.length, 16_000);
  } finally {
    restore();
    await executor.close();
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('the main client still rejects a streamed response above the shared snapshot cap', async () => {
  const job: ProgramJob = {
    id,
    workflowId: 'snapshot_size',
    workflowVersion: 1,
    versionId: 'version_snapshot_size',
    status: 'completed',
    input: {},
    nodes: {},
    result: { text: 'complete', sources: [] },
    artifacts: [],
    createdAt: 1,
    startedAt: 2,
    finishedAt: 3,
  };
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write(
      JSON.stringify({ ...job, extra: 'x'.repeat(PROGRAM_SNAPSHOT_MAX_BYTES) }),
    );
    response.end();
  });
  const restore = configure(await listen(server));
  try {
    await assert.rejects(
      fetchProgramJob(id),
      (error: unknown) =>
        error instanceof ProgramClientError &&
        error.status === 502 &&
        error.message.includes('读取上限'),
    );
  } finally {
    restore();
    await close(server);
  }
});
