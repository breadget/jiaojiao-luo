import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { compileGraphToProgram } from '../lib/workflow-graph/adapter/program';
import { createCourseProgramGraph } from '../lib/workflow-program/templates';
import { createGraphNode } from '../lib/workflow-graph/registry';
import type {
  ProgramJob,
  ProgramStartRequest,
} from '../lib/workflow-program/types';
import { callChatModel } from '../lib/server/llm';
import { ProgramExecutor } from '../services/workflow-program/executor';
import { ProgramStorage } from '../services/workflow-program/storage';
import { createProgramHttpServer } from '../services/workflow-program/server';
import {
  createCourseRetriever,
  courseOrigin,
} from '../services/workflow-program/course-transport';
import { requestFingerprint } from '../services/workflow-program/safety';

const token = 'test-program-service-bearer-token-32-chars';
const key = 'mock-private-provider-credential-never-write';
const sources = [
  {
    id: 'source_1',
    filename: '课程.pdf',
    page: 4,
    excerpt: '课程原文：实践与理论相互支持。',
    score: 0.8,
  },
];
const pause = (milliseconds: number) =>
  new Promise<void>((done) => setTimeout(done, milliseconds));

async function request(): Promise<ProgramStartRequest> {
  const graph = createCourseProgramGraph('workflow_course_test', {
    withModel: false,
  });
  const compiled = await compileGraphToProgram(graph, {
    workflowId: graph.id,
    version: 1,
  });
  assert.equal(compiled.ok, true, JSON.stringify(compiled.issues));
  return {
    id: `program_${randomBytes(16).toString('hex')}`,
    workflowId: graph.id,
    workflowName: graph.name,
    workflowVersion: 1,
    versionId: 'version_course_1',
    plan: compiled.plan!,
    input: { topic: '课程主题' },
    llm: {
      provider: 'custom',
      apiKey: key,
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'mock-model',
      reasoningEffort: 'auto',
    },
  };
}

async function stateDirectory(): Promise<string> {
  return mkdtemp(join(await realpath(tmpdir()), 'workflow-program-test-'));
}

async function waitFor(
  executor: ProgramExecutor,
  id: string,
  status: ProgramJob['status'],
): Promise<ProgramJob> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const job = executor.get(id);
    if (job?.status === status) return job;
    await pause(5);
  }
  assert.fail(`Expected ${status}; got ${JSON.stringify(executor.get(id))}`);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}

async function allFiles(root: string): Promise<string> {
  let result = '';
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    result += entry.isDirectory()
      ? await allFiles(path)
      : await readFile(path, 'utf8');
  }
  return result;
}

test('real graph execution survives caller lifetime, creates a durable downloadable artifact, and is idempotent', async () => {
  const directory = await stateDirectory();
  const storage = new ProgramStorage(directory);
  let retrieves = 0;
  const executor = new ProgramExecutor({
    storage,
    retrieveCourseSources: async () => {
      retrieves += 1;
      return sources;
    },
  });
  const server = createProgramHttpServer({ executor, storage, token });
  try {
    await executor.init();
    const origin = await listen(server);
    const value = await request();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    assert.equal((await fetch(`${origin}/health`)).status, 200);
    assert.equal((await fetch(`${origin}/v1/jobs/${value.id}`)).status, 401);
    assert.equal(
      (
        await fetch(`${origin}/v1/jobs`, {
          method: 'POST',
          headers,
          body: JSON.stringify(value),
        })
      ).status,
      202,
    );
    const job = await waitFor(executor, value.id, 'completed');
    assert.match(job.result!.text, /课程原文/);
    assert.equal(job.artifacts.length, 1);
    const download = await fetch(
      `${origin}/v1/jobs/${value.id}/artifacts/${job.artifacts[0].id}`,
      { headers },
    );
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition')!, /^attachment;/);
    assert.match(await download.text(), /课程.pdf/);
    const duplicate = structuredClone(value);
    duplicate.llm.apiKey = 'new-transient-key-on-retry';
    assert.equal((await executor.submit(duplicate)).status, 'completed');
    assert.equal(retrieves, 1);
    await assert.rejects(
      executor.submit({ ...value, input: { topic: '不同主题' } }),
      { code: 'JOB_CONFLICT' },
    );
    const other = await request();
    await executor.submit(other);
    await waitFor(executor, other.id, 'completed');
    assert.equal(
      (
        await fetch(
          `${origin}/v1/jobs/${other.id}/artifacts/${job.artifacts[0].id}`,
          { headers },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${origin}/v1/jobs/${value.id}/artifacts/..%2Fjob.json`, {
          headers,
        })
      ).status,
      404,
    );
    assert.ok(!(await allFiles(directory)).includes(key));
    const recovered = new ProgramExecutor({
      storage,
      retrieveCourseSources: async () => assert.fail('must not rerun'),
    });
    await recovered.init();
    assert.equal(recovered.get(value.id)?.status, 'completed');
    assert.equal((await recovered.submit(value)).status, 'completed');
    await recovered.close();
  } finally {
    await executor.close();
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTTP rejects malformed, oversized and credential-bearing requests without creating a job', async () => {
  const directory = await stateDirectory();
  const storage = new ProgramStorage(directory);
  const executor = new ProgramExecutor({
    storage,
    retrieveCourseSources: async () => sources,
  });
  const server = createProgramHttpServer({ executor, storage, token });
  try {
    await executor.init();
    const origin = await listen(server);
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    const send = (body: string | Buffer) =>
      fetch(`${origin}/v1/jobs`, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : new Uint8Array(body).buffer,
      });
    assert.equal((await send(Buffer.from([0xff, 0xfe]))).status, 400);
    assert.equal((await send('{')).status, 400);
    assert.equal((await send('x'.repeat(513 * 1024))).status, 413);
    const value = await request();
    const invalidInput = await send(
      JSON.stringify({ ...value, input: { topic: 5 } }),
    );
    assert.equal(invalidInput.status, 400);
    assert.equal(
      ((await invalidInput.json()) as { error: { code: string } }).error.code,
      'INVALID_INPUT',
    );
    const invalidGraph = structuredClone(value);
    invalidGraph.plan.graph.nodes[0].config.apiKey = key;
    assert.equal((await send(JSON.stringify(invalidGraph))).status, 400);
    assert.equal(
      (
        await send(
          JSON.stringify({ ...value, plan: { ...value.plan, graph: {} } }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${origin}/v1/jobs`, {
          method: 'POST',
          headers: { ...headers, Authorization: `Bearer ${token}wrong` },
          body: JSON.stringify(value),
        })
      ).status,
      401,
    );
    assert.equal(executor.get(value.id), null);
    assert.equal(await allFiles(directory), '');
    assert.throws(
      () => createProgramHttpServer({ executor, storage, token: 'short' }),
      /TOKEN/,
    );
  } finally {
    await executor.close();
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('expired dispatches cannot create work, while a durable existing job is replayed after expiry', async () => {
  const directory = await stateDirectory();
  const executor = new ProgramExecutor({
    storage: new ProgramStorage(directory),
    retrieveCourseSources: async () => sources,
  });
  try {
    await executor.init();
    const expired = await request();
    expired.dispatchExpiresAt = Date.now() - 1;
    await assert.rejects(executor.submit(expired), {
      code: 'DISPATCH_EXPIRED',
      status: 408,
    });
    assert.equal(executor.get(expired.id), null);
    const future = { ...expired, dispatchExpiresAt: Date.now() + 60_000 };
    await assert.rejects(executor.submit(future), { code: 'INVALID_REQUEST' });
    const live = await request();
    live.dispatchExpiresAt = Date.now() + 30_000;
    await executor.submit(live);
    await waitFor(executor, live.id, 'completed');
    live.dispatchExpiresAt = Date.now() - 1;
    assert.equal((await executor.submit(live)).status, 'completed');
  } finally {
    await executor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('oversized known-length and streaming uploads consistently receive HTTP 413 without a socket reset', async () => {
  const directory = await stateDirectory();
  const storage = new ProgramStorage(directory);
  const executor = new ProgramExecutor({
    storage,
    retrieveCourseSources: async () => sources,
  });
  const server = createProgramHttpServer({ executor, storage, token });
  try {
    await executor.init();
    const origin = await listen(server);
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    const oversized = 'x'.repeat(513 * 1024);
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await fetch(`${origin}/v1/jobs`, {
        method: 'POST',
        headers,
        body: oversized,
      });
      assert.equal(response.status, 413);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        'REQUEST_TOO_LARGE',
      );
    }
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await pause(1);
        if (sent >= 34) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(new Uint8Array(16 * 1024).fill(120));
      },
    });
    const streamed = await fetch(`${origin}/v1/jobs`, {
      method: 'POST',
      headers,
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    assert.equal(streamed.status, 413);
    assert.equal(
      ((await streamed.json()) as { error: { code: string } }).error.code,
      'REQUEST_TOO_LARGE',
    );
    assert.equal((await fetch(`${origin}/health`)).status, 200);
    assert.equal(await allFiles(directory), '');
  } finally {
    await executor.close();
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('disabled graph nodes remain skipped and accept engine snapshots without failing execution', async () => {
  const directory = await stateDirectory();
  const executor = new ProgramExecutor({
    storage: new ProgramStorage(directory),
    retrieveCourseSources: async () => sources,
  });
  try {
    await executor.init();
    const value = await request();
    value.plan.graph.nodes.push(
      createGraphNode(
        'transform',
        { x: 0, y: 0 },
        { id: 'disabled_example', name: 'Disabled example', disabled: true },
      ),
    );
    value.plan = (
      await compileGraphToProgram(value.plan.graph, {
        workflowId: value.workflowId,
        version: 1,
      })
    ).plan!;
    const queued = await executor.submit(value);
    assert.equal(queued.nodes.disabled_example.state, 'skipped');
    assert.equal(queued.nodes.disabled_example.startedAt, undefined);
    const job = await waitFor(executor, value.id, 'completed');
    assert.equal(job.nodes.disabled_example.state, 'skipped');
    assert.equal(job.error, undefined);
  } finally {
    await executor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('real model transport receives the selected transient configuration and HTTP cancellation aborts it', async () => {
  const directory = await stateDirectory();
  let modelCalls = 0;
  let stall = false;
  let aborted = false;
  const upstream = createServer(async (incoming, response) => {
    assert.equal(incoming.url, '/v1/chat/completions');
    assert.equal(incoming.headers.authorization, `Bearer ${key}`);
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
      string,
      unknown
    >;
    assert.equal(body.model, 'mock-selected-model');
    assert.equal(body.max_tokens, 4096);
    assert.match(JSON.stringify(body.messages), /课程原文/);
    modelCalls += 1;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (stall) {
      response.once('close', () => {
        aborted = true;
      });
      response.write('{');
    } else
      response.end(
        JSON.stringify({
          model: 'mock-selected-model',
          choices: [
            { message: { content: '依据资料 [1]：这里是练习与答案。' } },
          ],
        }),
      );
  });
  const storage = new ProgramStorage(directory);
  const executor = new ProgramExecutor({
    storage,
    retrieveCourseSources: async () => sources,
  });
  const server = createProgramHttpServer({ executor, storage, token });
  try {
    await executor.init();
    const upstreamOrigin = await listen(upstream);
    const serviceOrigin = await listen(server);
    const value = await request();
    const graph = createCourseProgramGraph(value.workflowId);
    value.plan = (
      await compileGraphToProgram(graph, {
        workflowId: value.workflowId,
        version: 1,
      })
    ).plan!;
    value.llm.baseUrl = `${upstreamOrigin}/v1`;
    value.llm.model = 'mock-selected-model';
    await executor.submit(value);
    const job = await waitFor(executor, value.id, 'completed');
    assert.match(job.result!.text, /练习与答案/);
    assert.deepEqual(job.result!.model, {
      provider: 'custom',
      model: 'mock-selected-model',
    });
    assert.equal(modelCalls, 1);
    stall = true;
    const cancelled = {
      ...value,
      id: `program_${randomBytes(16).toString('hex')}`,
    };
    await executor.submit(cancelled);
    const until = Date.now() + 2000;
    while (modelCalls < 2 && Date.now() < until) await pause(5);
    assert.equal(modelCalls, 2);
    const response = await fetch(`${serviceOrigin}/v1/jobs/${cancelled.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as ProgramJob).status, 'cancelled');
    await pause(30);
    assert.equal(aborted, true);
    assert.equal(executor.get(cancelled.id)?.status, 'cancelled');
    assert.equal(executor.get(cancelled.id)?.artifacts.length, 0);
    assert.ok(!(await allFiles(directory)).includes(key));
  } finally {
    await executor.close();
    await close(server);
    await close(upstream);
    await rm(directory, { recursive: true, force: true });
  }
});

test('queue is bounded, two jobs run, queued and running cancellation prevent late success', async () => {
  const directory = await stateDirectory();
  let active = 0;
  let peak = 0;
  let started = 0;
  const finish: Array<() => void> = [];
  const executor = new ProgramExecutor({
    storage: new ProgramStorage(directory),
    maxQueued: 2,
    run: async (_plan, _input, options) => {
      active += 1;
      started += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((done) => {
        const release = () => {
          options.signal?.removeEventListener('abort', release);
          done();
        };
        finish.push(release);
        options.signal?.addEventListener('abort', release, { once: true });
      });
      active -= 1;
      return { text: 'late success', sources: [] };
    },
  });
  try {
    await executor.init();
    const values = await Promise.all(
      Array.from({ length: 5 }, () => request()),
    );
    await executor.submit(values[0]);
    await executor.submit(values[1]);
    await waitFor(executor, values[0].id, 'running');
    await waitFor(executor, values[1].id, 'running');
    await executor.submit(values[2]);
    await executor.submit(values[3]);
    await assert.rejects(executor.submit(values[4]), {
      code: 'QUEUE_FULL',
      status: 429,
    });
    assert.equal((await executor.cancel(values[2].id)).status, 'cancelled');
    assert.equal((await executor.cancel(values[0].id)).status, 'cancelled');
    await waitFor(executor, values[3].id, 'running');
    assert.equal(started, 3);
    finish.splice(0).forEach((done) => done());
    await waitFor(executor, values[1].id, 'completed');
    await waitFor(executor, values[3].id, 'completed');
    assert.equal(executor.get(values[0].id)?.status, 'cancelled');
    assert.equal(executor.get(values[0].id)?.result, null);
    assert.equal(peak, 2);
  } finally {
    finish.forEach((done) => done());
    await executor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('timeout aborts work and late results cannot complete the job', async () => {
  const directory = await stateDirectory();
  let signal: AbortSignal | undefined;
  let finish!: () => void;
  const executor = new ProgramExecutor({
    storage: new ProgramStorage(directory),
    timeoutMs: 20,
    run: async (_plan, _input, options) => {
      signal = options.signal;
      await new Promise<void>((done) => {
        finish = done;
      });
      return { text: 'late', sources: [] };
    },
  });
  try {
    await executor.init();
    const value = await request();
    await executor.submit(value);
    const job = await waitFor(executor, value.id, 'failed');
    assert.equal(job.error?.code, 'PROGRAM_TIMEOUT');
    assert.equal(signal?.aborted, true);
    finish();
    await pause(15);
    assert.equal(executor.get(value.id)?.status, 'failed');
  } finally {
    finish?.();
    await executor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('restart marks persisted queued and running jobs failed without retaining credentials or reexecution', async () => {
  const directory = await stateDirectory();
  const storage = new ProgramStorage(directory);
  await storage.init();
  const values = [await request(), await request()];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    await storage.write({
      fingerprint: requestFingerprint(value),
      job: {
        id: value.id,
        workflowId: value.workflowId,
        workflowVersion: 1,
        versionId: value.versionId,
        status: index ? 'running' : 'queued',
        input: value.input,
        nodes: {},
        result: null,
        artifacts: [],
        createdAt: Date.now(),
        startedAt: index ? Date.now() : null,
        finishedAt: null,
      },
    });
  }
  const executor = new ProgramExecutor({
    storage,
    run: async () => assert.fail('must not rerun'),
  });
  try {
    await executor.init();
    for (const value of values) {
      assert.equal(executor.get(value.id)?.error?.code, 'WORKER_RESTARTED');
      assert.equal((await executor.submit(value)).status, 'failed');
    }
    assert.ok(!(await allFiles(directory)).includes(key));
  } finally {
    await executor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('nested snapshots, artifacts and errors redact echoed keys; filenames never control filesystem paths', async () => {
  const directory = await stateDirectory();
  const storage = new ProgramStorage(directory);
  const executor = new ProgramExecutor({
    storage,
    run: async (plan, _input, options) => {
      await options.onNode({
        id: plan.executionNodeIds[0],
        name: 'progress',
        state: 'running',
        output: { nested: [key, { apiKey: key, text: `echo ${key}` }] },
      });
      await options.writeArtifact({
        name: 'notes.md',
        mimeType: 'text/markdown',
        content: `output ${key}`,
      });
      await assert.rejects(
        options.writeArtifact({
          name: '../outside.txt',
          mimeType: 'text/plain',
          content: 'escape',
        }),
        { code: 'INVALID_ARTIFACT' },
      );
      throw new Error(`upstream echoed ${key}`);
    },
  });
  try {
    await executor.init();
    const value = await request();
    await executor.submit(value);
    const job = await waitFor(executor, value.id, 'failed');
    assert.match(job.error!.message, /REDACTED/);
    assert.ok(!JSON.stringify(job).includes(key));
    assert.ok(!(await allFiles(directory)).includes(key));
    assert.equal(job.artifacts.length, 1);
    assert.match(
      (await storage.readArtifact(
        value.id,
        job.artifacts[0].id,
      ))!.bytes.toString(),
      /REDACTED/,
    );
  } finally {
    await executor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('storage rejects symlinks for root, jobs, and artifacts', async () => {
  const directory = await stateDirectory();
  const outside = await stateDirectory();
  try {
    await symlink(outside, join(directory, 'linked'));
    await assert.rejects(
      new ProgramStorage(join(directory, 'linked')).init(),
      /Unsafe/,
    );
    const storage = new ProgramStorage(directory);
    await storage.init();
    const value = await request();
    await symlink(outside, join(directory, value.id));
    await assert.rejects(storage.read(value.id), /Unsafe/);
    const safeStorage = new ProgramStorage(outside);
    const executor = new ProgramExecutor({
      storage: safeStorage,
      retrieveCourseSources: async () => sources,
    });
    await executor.init();
    const safe = await request();
    await executor.submit(safe);
    const job = await waitFor(executor, safe.id, 'completed');
    const artifactPath = join(
      outside,
      safe.id,
      'artifacts',
      job.artifacts[0].id,
    );
    await rm(artifactPath);
    await writeFile(join(directory, 'private.txt'), 'private-data');
    await symlink(join(directory, 'private.txt'), artifactPath);
    await assert.rejects(
      safeStorage.readArtifact(safe.id, job.artifacts[0].id),
    );
    await executor.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('course retriever owns its CSRF session and forwards no provider credentials', async () => {
  const csrfToken = 'a'.repeat(32);
  let posts = 0;
  const server = createServer(async (incoming, response) => {
    assert.equal(incoming.headers.authorization, undefined);
    if (incoming.url === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html',
        'Set-Cookie': `csrftoken=${csrfToken}; Path=/; SameSite=Lax`,
      });
      response.end(
        `<input value="${csrfToken}" name="csrfmiddlewaretoken" type="hidden">`,
      );
      return;
    }
    assert.equal(incoming.url, '/api/retrieve/');
    assert.equal(incoming.headers['x-csrftoken'], csrfToken);
    assert.equal(incoming.headers.cookie, `csrftoken=${csrfToken}`);
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    assert.equal(body, JSON.stringify({ question: '课程主题' }));
    assert.ok(!body.includes(key));
    posts += 1;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    const bytes = Buffer.from(
      JSON.stringify({ question: '课程主题', sources }),
    );
    for (let index = 0; index < bytes.length; index += 7)
      response.write(bytes.subarray(index, index + 7));
    response.end();
  });
  try {
    const origin = await listen(server);
    assert.deepEqual(
      await createCourseRetriever(origin)(
        '课程主题',
        new AbortController().signal,
      ),
      sources,
    );
    assert.equal(posts, 1);
    assert.throws(() => courseOrigin('https://example.com'), /loopback/);
    assert.throws(() => courseOrigin(`${origin}/some/path`), /loopback/);
  } finally {
    await close(server);
  }
});

test('course and model transports reject redirects, bound bodies, and abort body consumption', async () => {
  let mode = 'redirect';
  const server = createServer((_incoming, response) => {
    if (mode === 'redirect') {
      response.writeHead(302, { Location: '/unsafe' });
      response.end();
    } else if (mode === 'large') {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(2 * 1024 * 1024),
      });
      response.end();
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{');
    }
  });
  try {
    const origin = await listen(server);
    await assert.rejects(
      createCourseRetriever(origin)('课程主题', new AbortController().signal),
      { code: 'COURSE_INVALID_RESPONSE' },
    );
    const model = {
      provider: 'custom',
      apiKey: key,
      baseUrl: `${origin}/v1`,
      model: 'mock-model',
      messages: [{ role: 'user' as const, content: 'hello' }],
    };
    const redirect = await callChatModel(model);
    assert.equal(redirect.ok, false);
    mode = 'large';
    const large = await callChatModel(model);
    assert.equal(large.ok, false);
    mode = 'stall';
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const start = Date.now();
    assert.equal(
      (
        await callChatModel({
          ...model,
          signal: controller.signal,
          timeoutMs: 3000,
        })
      ).ok,
      false,
    );
    assert.ok(Date.now() - start < 1000);
    await assert.rejects(
      createCourseRetriever(origin, 20)(
        '课程主题',
        new AbortController().signal,
      ),
      { code: 'COURSE_TIMEOUT' },
    );
  } finally {
    await close(server);
  }
});
