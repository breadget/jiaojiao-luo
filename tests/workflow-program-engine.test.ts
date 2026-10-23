import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compileGraphToProgram,
  programSnapshot,
} from '@/lib/workflow-graph/adapter/program';
import {
  createWorkflowAgentProposal,
  WorkflowAgentProposalError,
} from '@/lib/workflow-graph/agent';
import { createGraphNode } from '@/lib/workflow-graph/registry';
import { isWorkflowGraphPayload } from '@/lib/workflow-graph/payload';
import type {
  StudioNodeType,
  WorkflowGraphEdge,
  WorkflowGraphV1,
} from '@/lib/workflow-graph/types';
import {
  executeProgram,
  ProgramExecutionError,
  validateProgramInput,
  type ExecuteProgramOptions,
} from '@/lib/workflow-program/engine';
import { createCourseProgramGraph } from '@/lib/workflow-program/templates';
import type {
  ProgramNodeSnapshot,
  ProgramPlan,
} from '@/lib/workflow-program/types';
import type { CourseSource } from '@/lib/course-assistant-types';

const source: CourseSource = {
  id: 'chapter-2-page-3',
  filename: '运动控制.pdf',
  page: 3,
  excerpt: '比例控制器的输出与误差成正比。',
  score: 0.9,
};
const node = (
  id: string,
  type: StudioNodeType,
  config: Record<string, unknown> = {},
) => createGraphNode(type, { x: 0, y: 0 }, { id, name: id, config });
const edge = (
  from: string,
  to: string,
  branch?: 'true' | 'false',
): WorkflowGraphEdge => ({
  id: `${from}_${to}`,
  kind: branch ? 'branch' : 'main',
  source: { nodeId: from, portId: branch ? `branch.${branch}` : 'main.out' },
  target: { nodeId: to, portId: 'main.in' },
  ...(branch ? { condition: { branch } } : {}),
});

function branchingGraph(): WorkflowGraphV1 {
  return {
    ...createCourseProgramGraph('branch', { withModel: false }),
    nodes: [
      node('start', 'trigger'),
      node('choose', 'condition', { expression: '$json.message === "yes"' }),
      node('accepted', 'transform', {
        mapping: '{"text":"accepted:{{input.message}}"}',
      }),
      node('rejected', 'transform', { mapping: { text: 'rejected' } }),
      node('accept_output', 'output', { text: '{{nodes.accepted.text}}' }),
      node('reject_output', 'output', { text: '$json.text' }),
    ],
    edges: [
      edge('start', 'choose'),
      edge('choose', 'accepted', 'true'),
      edge('choose', 'rejected', 'false'),
      edge('accepted', 'accept_output'),
      edge('rejected', 'reject_output'),
    ],
    entryNodeIds: ['start'],
  };
}

async function planFor(graph: WorkflowGraphV1): Promise<ProgramPlan> {
  const compiled = await compileGraphToProgram(graph, {
    workflowId: graph.id,
    version: 1,
  });
  assert.equal(compiled.ok, true, JSON.stringify(compiled.issues));
  return compiled.plan!;
}

function harness(overrides: Partial<ExecuteProgramOptions> = {}) {
  const events: ProgramNodeSnapshot[] = [];
  const artifacts: Array<{ name: string; mimeType: string; content: string }> =
    [];
  const options: ExecuteProgramOptions = {
    llm: {
      provider: 'openai',
      apiKey: '',
      baseUrl: 'https://api.example.test/v1',
      model: 'shared-selected-model',
      reasoningEffort: 'low',
    },
    retrieveCourseSources: async () => [source],
    onNode: async (event) => {
      events.push(event);
    },
    writeArtifact: async (artifact) => {
      artifacts.push(artifact);
      return {
        id: 'artifact-1',
        name: artifact.name,
        mimeType: artifact.mimeType,
        sizeBytes: new TextEncoder().encode(artifact.content).length,
      };
    },
    callModel: async () => ({
      ok: true,
      text: '比例控制器与误差成正比。[1]',
      model: 'shared-selected-model',
    }),
    ...overrides,
  };
  return { events, artifacts, options };
}

describe('real graph PROGRAM compiler and executor', () => {
  it('compiles deterministic plans across save timestamps and normalizes server runtime', async () => {
    const graph = createCourseProgramGraph('source-export', {
      withModel: false,
    });
    assert.equal(isWorkflowGraphPayload(graph), true);
    const first = await compileGraphToProgram(graph, {
      workflowId: graph.id,
      version: 4,
    });
    const second = await compileGraphToProgram(
      {
        ...graph,
        revision: 19,
        metadata: { ...graph.metadata, updatedAt: Date.now() },
        runtime: {
          engine: 'n8n',
          adapter: 'n8n-v1',
          executionMode: 'webhook',
          binding: 'external',
        },
      },
      { workflowId: graph.id, version: 4 },
    );
    assert.equal(first.ok, true, JSON.stringify(first.issues));
    assert.equal(first.compiledHash, second.compiledHash);
    assert.equal(first.graphHash, second.graphHash);
    assert.deepEqual(first.plan!.graph.runtime, programSnapshot(graph).runtime);
    assert.deepEqual(first.requiredCredentialRefs, []);
  });

  it('rejects secret graphs, cycles, arbitrary code, unsupported effects and branch merges', async () => {
    const variants: WorkflowGraphV1[] = [];
    const secret = createCourseProgramGraph('secret');
    secret.nodes[0].config.apiKey = 'hidden';
    variants.push(secret);
    const urlSecret = createCourseProgramGraph('url-secret');
    urlSecret.nodes.find((item) => item.type === 'llmModel')!.config.baseUrl =
      'https://model.example.test/v1?api_key=hidden';
    variants.push(urlSecret);
    const cycle = branchingGraph();
    cycle.edges.push(edge('accepted', 'choose'));
    variants.push(cycle);
    const code = branchingGraph();
    code.nodes.find((item) => item.id === 'choose')!.config.expression =
      'process.exit()';
    variants.push(code);
    const robot = branchingGraph();
    robot.nodes.find((item) => item.id === 'accepted')!.type = 'robotAction';
    variants.push(robot);
    const http = branchingGraph();
    http.nodes.find((item) => item.id === 'accepted')!.type = 'httpRequest';
    variants.push(http);
    const merge = branchingGraph();
    merge.edges[4] = edge('rejected', 'accept_output');
    merge.nodes = merge.nodes.filter((item) => item.id !== 'reject_output');
    variants.push(merge);
    for (const graph of variants) {
      const result = await compileGraphToProgram(graph, {
        workflowId: graph.id,
        version: 1,
      });
      assert.equal(result.ok, false);
      assert.equal(result.compiledJson, null);
      assert.equal(result.plan, null);
    }
  });

  it('validates declared inputs before execution and applies typed defaults', async () => {
    const plan = await planFor(createCourseProgramGraph('typed'));
    assert.deepEqual(validateProgramInput(plan.inputFields, { topic: 'PID' }), {
      topic: 'PID',
      difficulty: '基础',
      count: 5,
    });
    for (const input of [
      {},
      { topic: 'PID', count: '5' },
      { topic: 'PID', count: 0 },
      { topic: 'PID', count: 21 },
      { topic: 'PID', extra: 'ignored?' },
      { topic: ' '.repeat(2) },
      { topic: 'x'.repeat(40_000) },
    ]) {
      assert.throws(
        () => validateProgramInput(plan.inputFields, input),
        (error: unknown) =>
          error instanceof ProgramExecutionError &&
          error.code === 'INVALID_INPUT',
      );
    }
    const run = harness();
    await assert.rejects(
      executeProgram(plan, { topic: 'PID', count: '5' }, run.options),
    );
    assert.equal(run.events.length, 0);
  });

  it('runs only the selected condition path and resolves actual prior-node outputs', async () => {
    const plan = await planFor(branchingGraph());
    for (const [message, expected, skipped] of [
      ['yes', 'accepted:yes', 'rejected'],
      ['no', 'rejected', 'accepted'],
    ]) {
      const run = harness();
      const result = await executeProgram(plan, { message }, run.options);
      assert.equal(result.text, expected);
      assert.equal(
        run.events.some(
          (event) => event.id === skipped && event.state === 'running',
        ),
        false,
      );
      assert.equal(
        run.events.filter((event) => event.id === skipped).at(-1)?.state,
        'skipped',
      );
      assert.equal(
        run.events.find(
          (event) => event.id === 'choose' && event.state === 'success',
        )?.output &&
          typeof run.events.find(
            (event) => event.id === 'choose' && event.state === 'success',
          )?.output,
        'object',
      );
    }
  });

  it('retrieves and exports real source excerpts without calling a model or requiring a key', async () => {
    const plan = await planFor(
      createCourseProgramGraph('sources', { withModel: false }),
    );
    const run = harness({
      retrieveCourseSources: async (query, signal) => {
        assert.equal(query, '控制器');
        assert.equal(signal.aborted, false);
        return [source];
      },
      callModel: async () => {
        assert.fail('source export must not call a model');
      },
    });
    const result = await executeProgram(
      plan,
      { topic: '控制器', count: 1 },
      run.options,
    );
    assert.match(result.text, /运动控制\.pdf · 第 3 页/);
    assert.match(result.text, /比例控制器的输出与误差成正比/);
    assert.deepEqual(result.sources, [source]);
    assert.equal(result.model, undefined);
    assert.equal(run.artifacts[0].content, result.text);
    assert.equal(
      run.events.find(
        (event) => event.id === 'course_sources' && event.state === 'running',
      )?.finishedAt,
      undefined,
    );
  });

  it('bounds literal and resolved course queries to the real 2000-character retrieval contract', async () => {
    const literal = createCourseProgramGraph('literal-query', {
      withModel: false,
    });
    literal.nodes.find(
      (item) => item.type === 'courseKnowledge',
    )!.config.query = '长'.repeat(2001);
    const rejected = await compileGraphToProgram(literal, {
      workflowId: literal.id,
      version: 1,
    });
    assert.equal(rejected.ok, false);
    assert.ok(rejected.issues.some((issue) => issue.message.includes('2000')));

    const graph = createCourseProgramGraph('resolved-query', {
      withModel: false,
    });
    graph.nodes.find((item) => item.type === 'trigger')!.config.inputFields = [
      { name: 'topic', label: '主题', type: 'text', required: true, max: 4000 },
    ];
    graph.nodes.find(
      (item) => item.type === 'courseKnowledge',
    )!.config.maxSources = 1;
    const run = harness({
      retrieveCourseSources: async () => {
        assert.fail('oversized resolved queries must fail before transport');
      },
    });
    await assert.rejects(
      executeProgram(
        await planFor(graph),
        { topic: '长'.repeat(2001) },
        run.options,
      ),
      (error: unknown) =>
        error instanceof ProgramExecutionError &&
        error.code === 'COURSE_INVALID_QUERY',
    );
    assert.equal(run.artifacts.length, 0);
  });

  it('uses shared provider/key/base URL/model/effort, constraints and untrusted evidence in actual model calls', async () => {
    const graph = createCourseProgramGraph('model');
    graph.nodes.find((item) => item.type === 'llmModel')!.config = {
      provider: 'deepseek',
      model: 'ignored-resource-model',
      baseUrl: 'https://ignored.example.test',
    };
    const plan = await planFor(graph);
    let called = false;
    const run = harness();
    run.options.llm.apiKey = 'unit-test-common-key';
    run.options.callModel = async (request) => {
      called = true;
      for (const field of [
        'provider',
        'apiKey',
        'baseUrl',
        'model',
        'reasoningEffort',
      ] as const)
        assert.equal(request[field], run.options.llm[field]);
      assert.ok(request.signal);
      assert.ok(request.timeoutMs! <= 45_000);
      assert.match(request.messages[0].content, /不得虚构资料/);
      assert.match(request.messages[0].content, /不可信的数据/);
      assert.match(request.messages.at(-1)!.content, /"page":3/);
      return {
        ok: true,
        text: '控制器输出与误差成正比。[1]',
        model: 'shared-selected-model',
      };
    };
    const result = await executeProgram(plan, { topic: '控制器' }, run.options);
    assert.equal(called, true);
    assert.match(result.text, /\[1\]/);
    assert.deepEqual(result.model, {
      provider: run.options.llm.provider,
      model: 'shared-selected-model',
    });
    assert.equal(
      JSON.stringify(run.events).includes('unit-test-common-key'),
      false,
    );
    assert.equal(
      JSON.stringify(run.artifacts).includes('unit-test-common-key'),
      false,
    );
  });

  it('preserves ordinary array notation in AI programs without course retrieval', async () => {
    const graph: WorkflowGraphV1 = {
      ...createCourseProgramGraph('ordinary-ai'),
      nodes: [
        node('start', 'trigger'),
        node('answer', 'aiAgent', { prompt: '$json.message' }),
        node('answer_model', 'llmModel'),
        node('output', 'output', { text: '$json.text' }),
      ],
      edges: [
        edge('start', 'answer'),
        edge('answer', 'output'),
        {
          id: 'answer_model_resource',
          kind: 'model',
          source: { nodeId: 'answer', portId: 'resource.model' },
          target: { nodeId: 'answer_model', portId: 'model.provider' },
        },
      ],
      entryNodeIds: ['start'],
    };
    const run = harness({
      retrieveCourseSources: async () => {
        assert.fail('ordinary AI programs must not retrieve course sources');
      },
      callModel: async () => ({
        ok: true,
        text: '数组 a[1] 是第二个元素，a[0] 是第一个元素。',
        model: 'stub',
      }),
    });
    const result = await executeProgram(
      await planFor(graph),
      { message: '解释数组索引' },
      run.options,
    );
    assert.equal(result.text, '数组 a[1] 是第二个元素，a[0] 是第一个元素。');
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.model, {
      provider: run.options.llm.provider,
      model: 'stub',
    });
  });

  it('fails honestly on model errors, invalid citations or missing source evidence', async () => {
    const plan = await planFor(createCourseProgramGraph('failure'));
    const modelFailure = harness({
      callModel: async () => ({
        ok: false,
        code: 'UPSTREAM_ERROR',
        error: 'service unavailable',
      }),
    });
    await assert.rejects(
      executeProgram(plan, { topic: '控制器' }, modelFailure.options),
      (error: unknown) =>
        error instanceof ProgramExecutionError &&
        error.code === 'UPSTREAM_ERROR',
    );
    assert.equal(
      modelFailure.events.find(
        (event) => event.id === 'course_writer' && event.state === 'error',
      )?.error,
      'service unavailable',
    );
    assert.equal(modelFailure.artifacts.length, 0);
    const invented = harness({
      callModel: async () => ({
        ok: true,
        text: '虚构来源 [99]',
        model: 'stub',
      }),
    });
    await assert.rejects(
      executeProgram(plan, { topic: '控制器' }, invented.options),
      (error: unknown) =>
        error instanceof ProgramExecutionError &&
        error.code === 'UNGROUNDED_CITATION',
    );
    const missing = harness({
      retrieveCourseSources: async () => [],
      callModel: async () => {
        assert.fail('missing sources must not be generated');
      },
    });
    await assert.rejects(
      executeProgram(plan, { topic: '控制器' }, missing.options),
      (error: unknown) =>
        error instanceof ProgramExecutionError &&
        error.code === 'COURSE_NO_SOURCES',
    );
    assert.equal(missing.artifacts.length, 0);
  });

  it('cancels an in-flight real retrieval promptly and never writes output', async () => {
    const controller = new AbortController();
    const plan = await planFor(
      createCourseProgramGraph('cancel', { withModel: false }),
    );
    const run = harness({
      signal: controller.signal,
      retrieveCourseSources: async (_query, signal) => {
        controller.abort();
        assert.equal(signal.aborted, true);
        return new Promise(() => undefined);
      },
    });
    await assert.rejects(
      executeProgram(plan, { topic: '控制器' }, run.options),
      (error: unknown) =>
        error instanceof ProgramExecutionError && error.code === 'CANCELLED',
    );
    assert.equal(run.artifacts.length, 0);
    assert.equal(
      run.events.some(
        (event) => event.id === 'course_output' && event.state === 'running',
      ),
      false,
    );
  });

  it('cancels an in-flight model call and threads the cancellation signal into the shared API', async () => {
    const controller = new AbortController();
    const plan = await planFor(createCourseProgramGraph('cancel-model'));
    const run = harness({
      signal: controller.signal,
      callModel: async (request) => {
        controller.abort();
        assert.equal(request.signal?.aborted, true);
        return new Promise(() => undefined);
      },
    });
    await assert.rejects(
      executeProgram(plan, { topic: '控制器' }, run.options),
      (error: unknown) =>
        error instanceof ProgramExecutionError && error.code === 'CANCELLED',
    );
    assert.equal(run.artifacts.length, 0);
  });

  it('shares explicit job memory across agents and clears it between jobs', async () => {
    const memory = node('memory', 'memory', { provider: 'job', maxTurns: 1 });
    memory.ports[0].maxConnections = null;
    const graph = {
      ...createCourseProgramGraph('memory-job'),
      nodes: [
        node('start', 'trigger'),
        node('first', 'aiAgent', { prompt: '$json.message' }),
        node('second', 'aiAgent', { prompt: '$json.text' }),
        node('model1', 'llmModel'),
        node('model2', 'llmModel'),
        memory,
        node('end', 'output'),
      ],
      edges: [
        edge('start', 'first'),
        edge('first', 'second'),
        edge('second', 'end'),
        ...['first', 'second'].flatMap((id, index): WorkflowGraphEdge[] => [
          {
            id: `${id}_model`,
            kind: 'model',
            source: { nodeId: id, portId: 'resource.model' },
            target: { nodeId: `model${index + 1}`, portId: 'model.provider' },
          },
          {
            id: `${id}_memory`,
            kind: 'memory',
            source: { nodeId: id, portId: 'resource.memory' },
            target: { nodeId: memory.id, portId: 'memory.provider' },
          },
        ]),
      ],
      entryNodeIds: ['start'],
    };
    const plan = await planFor(graph);
    for (let job = 0; job < 2; job += 1) {
      let calls = 0;
      const run = harness({
        callModel: async (request) => {
          assert.equal(request.messages.length, calls === 0 ? 2 : 4);
          if (calls === 1) assert.equal(request.messages[2].role, 'assistant');
          calls += 1;
          return {
            ok: true,
            text: `turn-${calls}`,
            model: 'shared-selected-model',
          };
        },
      });
      assert.equal(
        (await executeProgram(plan, { message: 'hello' }, run.options)).text,
        'turn-2',
      );
      assert.equal(
        run.events.filter(
          (item) => item.id === memory.id && item.state === 'success',
        ).length,
        2,
      );
    }
  });

  it('rejects a forged plan schedule before callbacks or effects', async () => {
    const plan = await planFor(branchingGraph());
    plan.executionNodeIds.reverse();
    const run = harness();
    await assert.rejects(
      executeProgram(plan, { message: 'yes' }, run.options),
      (error: unknown) =>
        error instanceof ProgramExecutionError && error.code === 'INVALID_PLAN',
    );
    assert.equal(run.events.length, 0);
  });

  it('does not allow prototype access or treat a transform mapping as executable code', async () => {
    const unsafe = branchingGraph();
    unsafe.nodes.find((item) => item.id === 'accepted')!.config.mapping = {
      text: '{{input.constructor}}',
    };
    assert.equal(
      (
        await compileGraphToProgram(unsafe, {
          workflowId: unsafe.id,
          version: 1,
        })
      ).ok,
      false,
    );
    const inert = branchingGraph();
    inert.nodes.find((item) => item.id === 'accepted')!.config.mapping = {
      text: 'process.exit()',
    };
    const run = harness();
    assert.equal(
      (
        await executeProgram(
          await planFor(inert),
          { message: 'yes' },
          run.options,
        )
      ).text,
      'process.exit()',
    );
  });

  it('lets the creator Agent generate bounded typed course inputs and a real text artifact', async () => {
    const blueprint = {
      schemaVersion: 1,
      summary: '创建课程原文导出程序',
      name: '课程原文导出',
      description: '实际检索并导出资料',
      nodes: [
        {
          key: 'start',
          type: 'trigger',
          name: '主题',
          description: '填写主题',
          config: {
            inputFields: [
              { name: 'topic', label: '主题', type: 'text', required: true },
              {
                name: 'count',
                label: '条数',
                type: 'number',
                default: 5,
                min: 1,
                max: 20,
              },
            ],
          },
        },
        {
          key: 'sources',
          type: 'courseKnowledge',
          name: '课程资料',
          description: '检索原文',
          config: { query: '{{input.topic}}', maxSources: '{{input.count}}' },
        },
        {
          key: 'output',
          type: 'output',
          name: '下载原文',
          description: '导出原文',
          config: {
            text: '$json.text',
            artifact: { name: 'sources.md', mimeType: 'text/markdown' },
          },
        },
      ],
      connections: [
        {
          sourceKey: 'start',
          sourcePort: 'main.out',
          targetKey: 'sources',
          targetPort: 'main.in',
        },
        {
          sourceKey: 'sources',
          sourcePort: 'main.out',
          targetKey: 'output',
          targetPort: 'main.in',
        },
      ],
    };
    const proposal = createWorkflowAgentProposal(JSON.stringify(blueprint), {
      mode: 'create',
    });
    assert.equal(proposal.graph.runtime.engine, 'program');
    const run = harness();
    const result = await executeProgram(
      await planFor(proposal.graph),
      { topic: '比例控制器' },
      run.options,
    );
    assert.equal(run.artifacts[0].content, result.text);
    const unsafe = structuredClone(blueprint);
    unsafe.nodes[2].config = {
      text: '$json.text',
      artifact: { name: '../../sources.md', mimeType: 'text/markdown' },
    };
    assert.throws(
      () =>
        createWorkflowAgentProposal(JSON.stringify(unsafe), { mode: 'create' }),
      WorkflowAgentProposalError,
    );
  });
});
