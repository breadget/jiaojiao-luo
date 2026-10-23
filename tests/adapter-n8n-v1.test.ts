import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Script } from 'node:vm';
import { canaryGraph, chainGraph, largeGraph } from './helpers/graph';
import {
  compileGraphToN8n,
  supportedNodeTypes,
} from '@/lib/workflow-graph/adapter/n8n-v1';
import { canonicalJson, hashGraphContent } from '@/lib/workflow-graph/hash';
import type {
  N8nConnectionTarget,
  N8nWorkflow,
} from '@/lib/workflow-graph/adapter/types';
import type { WorkflowGraphV1 } from '@/lib/workflow-graph/types';

const OPTIONS = { workflowId: 'wf_canary', version: 1 };

function compile(graph: WorkflowGraphV1 = canaryGraph(), version = 1) {
  return compileGraphToN8n(graph, { ...OPTIONS, version });
}

function workflowOf(result: Awaited<ReturnType<typeof compile>>): N8nWorkflow {
  assert.ok(result.workflow, '编译应当成功');
  return result.workflow;
}

function findNode(workflow: N8nWorkflow, internalNodeId: string) {
  const name = `U::${internalNodeId}::`;
  const node = workflow.nodes.find((candidate) =>
    candidate.name.startsWith(name),
  );
  assert.ok(node, `应当有 ${internalNodeId} 对应的 n8n 节点`);
  return node;
}

function outputs(
  workflow: N8nWorkflow,
  nodeName: string,
  type: string,
): N8nConnectionTarget[][] {
  return workflow.connections[nodeName]?.[type] ?? [];
}

type N8nCodeResult = { json: Record<string, unknown> }[];

/**
 * Execute generated n8n Code-node source without Function/eval. The adapter
 * output is intentionally tested as executable JavaScript, and vm.Script
 * keeps that test isolated from the test runner's lexical scope.
 */
function runGeneratedCode(
  source: string,
  globals: Record<string, unknown>,
): N8nCodeResult {
  const script = new Script(`(function () {\n${source}\n})()`);
  return script.runInNewContext(globals) as N8nCodeResult;
}

describe('Graph → n8n Adapter v1', () => {
  it('第一版支持的类型与约定一致', () => {
    assert.deepEqual([...supportedNodeTypes].sort(), [
      'aiAgent',
      'condition',
      'httpRequest',
      'llmModel',
      'memory',
      'output',
      'robotAction',
      'tool',
      'trigger',
    ]);
  });

  it('编译 Canary 图成功，并为输入/输出生成可追踪的边界节点', async () => {
    const graph = canaryGraph();
    const result = await compile(graph);
    assert.equal(result.ok, true);
    assert.equal(
      result.issues.filter((issue) => issue.level === 'error').length,
      0,
    );

    const workflow = workflowOf(result);
    const boundaryCount = graph.nodes.filter(
      (node) => node.type === 'trigger' || node.type === 'output',
    ).length;
    assert.equal(workflow.nodes.length, graph.nodes.length + boundaryCount + 2);
    assert.equal(result.bindings.length, workflow.nodes.length);
    assert.equal(
      new Set(result.bindings.map((binding) => binding.internalNodeId)).size,
      graph.nodes.length,
    );
    assert.equal(
      new Set(result.bindings.map((binding) => binding.externalNodeId)).size,
      workflow.nodes.length,
    );
    assert.ok(result.bindings.some((binding) => binding.role === 'input'));
    assert.ok(result.bindings.some((binding) => binding.role === 'envelope'));
  });

  it('重复编译结果逐字节一致，hash 相同', async () => {
    const graph = canaryGraph();
    const first = await compile(graph);
    const second = await compile(canaryGraph());
    assert.equal(first.compiledJson, second.compiledJson);
    assert.equal(first.compiledHash, second.compiledHash);
    assert.equal(first.graphHash, second.graphHash);
    assert.equal(first.graphHash, await hashGraphContent(graph));
  });

  it('compiledJson 是规范 JSON，反解后与 workflow 一致', async () => {
    const result = await compile();
    assert.equal(result.compiledJson, canonicalJson(result.workflow));
    assert.deepEqual(JSON.parse(result.compiledJson ?? ''), result.workflow);
  });

  it('节点 id 是 UUID 形状且由 workflowId + version + nodeId + role 决定', async () => {
    const first = await compile();
    const other = await compile(canaryGraph(), 2);
    for (const binding of first.bindings) {
      assert.match(
        binding.externalNodeId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      assert.equal(
        binding.externalNodeName,
        `U::${binding.internalNodeId}::${binding.role}`,
      );
    }
    const before = new Map(
      first.bindings.map((b) => [b.internalNodeId, b.externalNodeId]),
    );
    for (const binding of other.bindings) {
      assert.notEqual(
        binding.externalNodeId,
        before.get(binding.internalNodeId),
        '版本变化必须让节点 id 变化（每次发布是独立快照）',
      );
    }
  });

  it('不同 workflowId 编译出不同的节点 id', async () => {
    const graph = canaryGraph();
    const a = await compileGraphToN8n(graph, {
      workflowId: 'wf_a',
      version: 1,
    });
    const b = await compileGraphToN8n(graph, {
      workflowId: 'wf_b',
      version: 1,
    });
    assert.notEqual(a.bindings[0].externalNodeId, b.bindings[0].externalNodeId);
  });

  it('每个 n8n 节点都写全六个必需键', async () => {
    const workflow = workflowOf(await compile());
    for (const node of workflow.nodes) {
      for (const key of [
        'id',
        'name',
        'type',
        'typeVersion',
        'position',
        'parameters',
      ]) {
        assert.ok(key in node, `${node.name} 缺少 ${key}`);
      }
      assert.equal(node.position.length, 2);
    }
  });

  it('typeVersion 与 n8n 2.38.6 的实测版本表一致', async () => {
    const workflow = workflowOf(await compile());
    const versions = workflow.nodes.map((node) => [
      node.name,
      node.type,
      node.typeVersion,
    ]);
    const expected: Record<string, number> = {
      'n8n-nodes-base.webhook': 2,
      'n8n-nodes-base.code': 2,
      'n8n-nodes-base.if': 2.2,
      'n8n-nodes-base.httpRequest': 4.2,
      'n8n-nodes-base.respondToWebhook': 1.5,
      '@n8n/n8n-nodes-langchain.agent': 3.1,
      '@n8n/n8n-nodes-langchain.lmChatOpenAi': 1.3,
      '@n8n/n8n-nodes-langchain.memoryBufferWindow': 1.4,
      '@n8n/n8n-nodes-langchain.toolHttpRequest': 1.1,
    };
    for (const [name, type, typeVersion] of versions) {
      assert.equal(
        typeVersion,
        expected[type as string],
        `${name} (${type}) 版本不对`,
      );
    }
  });

  it('IF 的 conditions.options.version 与 typeVersion 2.2 成对（写成 3 会静默算错）', async () => {
    const workflow = workflowOf(await compile());
    const ifNode = findNode(workflow, 'node_route');
    const conditions = ifNode.parameters.conditions as {
      options: { version: number };
      combinator: string;
      conditions: {
        leftValue: string;
        rightValue: unknown;
        operator: { operation: string };
      }[];
    };
    assert.equal(ifNode.typeVersion, 2.2);
    assert.equal(conditions.options.version, 2);
    assert.equal(conditions.combinator, 'and');
    assert.equal(
      conditions.conditions[0].leftValue,
      '={{ $json.priority === "high" }}',
    );
    assert.equal(conditions.conditions[0].operator.operation, 'true');
  });

  it('Condition 的 true/false 分别落在 if 节点的输出 0 / 1', async () => {
    const workflow = workflowOf(await compile());
    const ifName = 'U::node_route::primary';
    const main = outputs(workflow, ifName, 'main');
    assert.equal(main.length, 2);
    assert.equal(main[0][0].node, 'U::node_agent::primary');
    assert.equal(main[1][0].node, 'U::node_http::primary');
  });

  it('AI 子连接挂在子节点上并指向 Agent（n8n 的方向）', async () => {
    const workflow = workflowOf(await compile());
    const agent = 'U::node_agent::primary';
    const modelOutputs = outputs(
      workflow,
      'U::node_model::model',
      'ai_languageModel',
    );
    const memoryOutputs = outputs(
      workflow,
      'U::node_memory::memory',
      'ai_memory',
    );
    const toolOutputs = outputs(workflow, 'U::node_tool::tool', 'ai_tool');
    assert.equal(modelOutputs[0][0].node, agent);
    assert.equal(memoryOutputs[0][0].node, agent);
    assert.equal(toolOutputs[0][0].node, agent);
    // Agent 自己不应该持有 ai_* 连接
    assert.equal(workflow.connections[agent]?.ai_languageModel, undefined);
  });

  it('主链路连接从源节点出发、目标索引为 0', async () => {
    const workflow = workflowOf(await compile());
    const trigger = outputs(workflow, 'U::node_trigger::primary', 'main');
    assert.deepEqual(trigger[0], [
      { node: 'U::node_trigger::input', type: 'main', index: 0 },
    ]);
    assert.deepEqual(
      outputs(workflow, 'U::node_trigger::binding-guard', 'main')[0],
      [{ node: 'U::node_route::primary', type: 'main', index: 0 }],
    );
    const agent = outputs(workflow, 'U::node_agent::primary', 'main');
    assert.equal(agent[0][0].node, 'U::node_robot::primary');

    const robot = outputs(workflow, 'U::node_robot::primary', 'main');
    const http = outputs(workflow, 'U::node_http::primary', 'main');
    assert.equal(robot[0][0].node, 'U::node_out::envelope');
    assert.equal(http[0][0].node, 'U::node_out::envelope');
    assert.equal(
      outputs(workflow, 'U::node_out::envelope', 'main')[0][0].node,
      'U::node_out::primary',
    );
  });

  it('产物里没有任何 credentials / 密钥字段', async () => {
    const result = await compile();
    const json = result.compiledJson ?? '';
    assert.ok(!json.includes('"credentials"'), '产物不得包含 credentials');
    assert.ok(!json.includes('apiKey'), '产物不得包含 apiKey');
    assert.ok(!json.includes('Authorization'), '产物不得包含 Authorization');
    assert.ok(!json.includes('sk-'), '产物不得包含密钥前缀');
    // 需要凭据的节点只把引用名交出来，由运维在克隆环境挂载
    assert.deepEqual(result.requiredCredentialRefs, [
      'headerAuth',
      'openAiApi',
      'urtorisEventsHeaderAuth',
    ]);
  });

  it('Graph 里混入的密钥字段不会进入产物（白名单）', async () => {
    const graph = canaryGraph();
    const model = graph.nodes.find((node) => node.id === 'node_model');
    assert.ok(model);
    model.config = { ...model.config, apiKey: 'sk-abcdefghijklmnopqrstuvwx' };
    const result = await compileGraphToN8n(graph, OPTIONS);
    assert.equal(result.ok, true);
    assert.ok(
      !(result.compiledJson ?? '').includes('sk-abcdefghijklmnopqrstuvwx'),
    );
    assert.ok(
      result.issues.some(
        (issue) =>
          issue.level === 'warning' && issue.message.includes('config.apiKey'),
      ),
      '被丢弃的配置必须有 warning，不能静默',
    );
  });

  it('不支持的节点类型直接拒绝编译，且不产出任何半成品', async () => {
    const graph = canaryGraph();
    graph.nodes.push({
      ...graph.nodes[0],
      id: 'node_db',
      type: 'database',
      name: '数据库查询',
      config: { operation: 'select' },
    });
    const result = await compileGraphToN8n(graph, OPTIONS);
    assert.equal(result.ok, false);
    assert.equal(result.workflow, null);
    assert.equal(result.compiledJson, null);
    assert.equal(result.compiledHash, null);
    assert.deepEqual(result.bindings, []);
    assert.ok(
      result.issues.some(
        (issue) =>
          issue.level === 'error' &&
          issue.message.includes('database') &&
          issue.message.includes('不会静默丢弃'),
      ),
    );
  });

  it('缺失必填配置时报错并点名节点（Robot Action 缺 endpoint）', async () => {
    const graph = canaryGraph();
    const robot = graph.nodes.find((node) => node.id === 'node_robot');
    assert.ok(robot);
    robot.config = { action: 'dispatch', confirmation: 'on-risk' };
    const result = await compileGraphToN8n(graph, OPTIONS);
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some(
        (issue) =>
          issue.level === 'error' && issue.message.includes('config.endpoint'),
      ),
    );
  });

  it('HTTP Tool 的非 HTTP 实现被拒绝', async () => {
    const graph = canaryGraph();
    const tool = graph.nodes.find((node) => node.id === 'node_tool');
    assert.ok(tool);
    tool.config = { implementation: 'robot' };
    const result = await compileGraphToN8n(graph, OPTIONS);
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some((issue) => issue.message.includes('只支持 HTTP 实现')),
    );
  });

  it('validator 的 error 会阻断编译（Condition 缺 false 分支）', async () => {
    const graph = canaryGraph();
    graph.edges = graph.edges.filter(
      (edge) => edge.source.portId !== 'branch.false',
    );
    const result = await compileGraphToN8n(graph, OPTIONS);
    assert.equal(result.ok, false);
    assert.equal(result.workflow, null);
    assert.ok(
      result.issues.some((issue) => issue.message.includes('false 分支')),
    );
  });

  it('validator 的 warning 不阻断编译（Agent 没接 Memory）', async () => {
    const graph = canaryGraph();
    graph.edges = graph.edges.filter((edge) => edge.kind !== 'memory');
    const result = await compileGraphToN8n(graph, OPTIONS);
    assert.equal(result.ok, true);
    assert.ok(result.issues.some((issue) => issue.level === 'warning'));
  });

  it('未绑定 webhook 的图也能编译（导入后由运维启用）', async () => {
    const graph = chainGraph(['trigger', 'output']);
    const result = await compileGraphToN8n(graph, OPTIONS);
    assert.equal(result.ok, true);
    assert.equal(workflowOf(result).active, false);
    assert.equal(workflowOf(result).settings.executionOrder, 'v1');
  });

  it('100 节点的编译同样是确定性的', async () => {
    const graph = largeGraph(100);
    const first = await compileGraphToN8n(graph, {
      workflowId: 'wf_large',
      version: 1,
    });
    const second = await compileGraphToN8n(largeGraph(100), {
      workflowId: 'wf_large',
      version: 1,
    });
    assert.equal(first.compiledHash, second.compiledHash);
  });

  it('n8n 的 meta 里留下可回溯的 adapter 信息（不含时间戳）', async () => {
    const workflow = workflowOf(await compile());
    const meta = workflow.meta.urtoris as Record<string, unknown>;
    assert.equal(meta.adapter, 'n8n-v1');
    assert.equal(meta.adapterVersion, '1.2.1');
    assert.equal(meta.workflowId, 'wf_canary');
    assert.equal(meta.version, 1);
    assert.match(String(meta.graphHash), /^[0-9a-f]{64}$/);
    assert.ok(!('publishedAt' in meta), '产物不能带时间戳，否则哈希不稳定');
  });

  it('自定义 webhookPath 会写进产物', async () => {
    const result = await compileGraphToN8n(canaryGraph(), {
      ...OPTIONS,
      webhookPath: 'urtoris/custom-path',
    });
    const trigger = findNode(workflowOf(result), 'node_trigger');
    assert.equal(trigger.parameters.path, 'urtoris/custom-path');
  });

  it('默认 webhookPath 由 workflowId 确定性派生', async () => {
    const first = await compileGraphToN8n(canaryGraph(), {
      workflowId: 'wf Canary 1',
      version: 1,
    });
    const trigger = findNode(workflowOf(first), 'node_trigger');
    assert.equal(trigger.parameters.path, 'urtoris/wf-canary-1');

    const underscored = await compileGraphToN8n(canaryGraph(), {
      workflowId: 'wf_canary',
      version: 1,
    });
    assert.equal(
      findNode(workflowOf(underscored), 'node_trigger').parameters.path,
      'urtoris/wf_canary',
    );
  });

  it('Webhook 输入归一节点会展平 body 并补齐稳定字段', async () => {
    const workflow = workflowOf(await compile());
    const normalizer = workflow.nodes.find(
      (node) => node.name === 'U::node_trigger::input',
    );
    assert.ok(normalizer);
    assert.equal(normalizer.type, 'n8n-nodes-base.code');
    const jsCode = String(normalizer.parameters.jsCode);
    const result = runGeneratedCode(jsCode, {
      $input: {
        first: () => ({
          json: {
            body: {
              requestId: 'req-101',
              sessionId: 'sess-202',
              message: '请处理工单',
              context: { channel: 'web', urgency: 'high' },
            },
          },
        }),
      },
      $execution: { id: 'exec-303' },
    });
    assert.equal(result[0].json.requestId, 'req-101');
    assert.equal(result[0].json.sessionId, 'sess-202');
    assert.equal(result[0].json.message, '请处理工单');
    assert.equal(result[0].json.question, '请处理工单');
    assert.equal(result[0].json.channel, 'web');
    assert.equal(result[0].json.urgency, 'high');
    assert.equal(result[0].json.workflowId, 'wf_canary');
    assert.equal(result[0].json.__urtorisExecutionId, 'exec-303');
    assert.equal(typeof result[0].json.__urtorisStartedAt, 'number');
  });

  it('终端 JSON 参数进入业务节点，但不能覆盖协议链路字段', async () => {
    const workflow = workflowOf(await compile());
    const normalizer = workflow.nodes.find(
      (node) => node.name === 'U::node_trigger::input',
    );
    assert.ok(normalizer);
    const businessInput = JSON.parse(
      '{"question":"自定义输入","count":0,"options":{"retry":false},"requestId":"fake-request","sessionId":"fake-session","workflowId":"fake-workflow","protocol":"fake","__proto__":{"polluted":true}}',
    );
    const result = runGeneratedCode(String(normalizer.parameters.jsCode), {
      $input: {
        first: () => ({
          json: {
            body: {
              protocol: 'urtoris.v1',
              requestId: 'req-terminal-101',
              sessionId: 'sess-terminal-202',
              message: '',
              context: { input: businessInput },
            },
          },
        }),
      },
      $execution: { id: 'exec-terminal-303' },
    });
    const output = result[0].json;
    assert.equal(output.question, '自定义输入');
    assert.equal(output.count, 0);
    assert.equal(JSON.stringify(output.options), '{"retry":false}');
    assert.equal(output.requestId, 'req-terminal-101');
    assert.equal(output.sessionId, 'sess-terminal-202');
    assert.equal(output.workflowId, 'wf_canary');
    assert.equal(output.protocol, 'urtoris.v1');
    assert.equal(output.polluted, undefined);
  });

  it('输出归一节点会产生 urtoris.v1 成功信封', async () => {
    const workflow = workflowOf(await compile());
    const envelope = workflow.nodes.find(
      (node) => node.name === 'U::node_out::envelope',
    );
    assert.ok(envelope);
    const jsCode = String(envelope.parameters.jsCode);
    const root = {
      requestId: 'req-envelope',
      sessionId: 'sess-envelope',
      __urtorisExecutionId: 'exec-envelope',
      __urtorisStartedAt: Date.now() - 5,
    };
    const result = runGeneratedCode(jsCode, {
      $input: { first: () => ({ json: { output: '{"answer":"ok"}' } }) },
      $: (name: string) => {
        if (name === 'U::node_agent::primary') return { isExecuted: true };
        assert.equal(name, 'U::node_trigger::input');
        return { first: () => ({ json: root }) };
      },
    });
    const body = result[0].json as {
      protocol: string;
      success: boolean;
      requestId: string;
      engine: string;
      workflow: string;
      mode: string;
      degraded: boolean;
      data: Record<string, unknown>;
      error: unknown;
      meta: Record<string, unknown>;
    };
    assert.equal(body.protocol, 'urtoris.v1');
    assert.equal(body.success, true);
    assert.equal(body.requestId, 'req-envelope');
    assert.equal(body.engine, 'n8n');
    assert.equal(body.workflow, 'wf_canary');
    assert.equal(body.mode, 'llm');
    assert.equal(body.degraded, false);
    assert.equal(body.data.answer, 'ok');
    assert.equal(body.data.outputNodeId, 'node_out');
    assert.equal(body.data.outputNodeName, '返回结果');
    assert.equal(body.error, null);
    assert.equal(body.meta.sessionId, 'sess-envelope');
    assert.equal(body.meta.executionId, 'exec-envelope');
  });

  it('Memory 会把历史节点表达式重绑定到输入归一节点', async () => {
    const graph = canaryGraph();
    const memory = graph.nodes.find((node) => node.id === 'node_memory');
    assert.ok(memory);
    memory.config = {
      ...memory.config,
      sessionKey: "={{ $('old_internal_name').item.json.body.sessionId }}",
    };
    const workflow = workflowOf(await compileGraphToN8n(graph, OPTIONS));
    const memoryNode = findNode(workflow, 'node_memory');
    assert.equal(
      memoryNode.parameters.sessionKey,
      "={{ $('U::node_trigger::input').first().json.sessionId }}",
    );
  });

  it('Memory 不可识别的 sessionKey 表达式会 fail closed', async () => {
    const graph = canaryGraph();
    const memory = graph.nodes.find((node) => node.id === 'node_memory');
    assert.ok(memory);
    memory.config = { ...memory.config, sessionKey: '$json[sessionField]' };
    const result = await compileGraphToN8n(graph, OPTIONS);
    assert.equal(result.ok, false);
    assert.equal(result.workflow, null);
    assert.ok(
      result.issues.some(
        (issue) =>
          issue.level === 'error' && issue.message.includes('sessionKey'),
      ),
    );
  });

  it('AI Agent 明确编译失败策略，非法值会被拒绝', async () => {
    const errorGraph = canaryGraph();
    const errorAgent = errorGraph.nodes.find(
      (node) => node.id === 'node_agent',
    );
    assert.ok(errorAgent);
    errorAgent.config = { ...errorAgent.config, fallbackPolicy: 'error' };
    const errorWorkflow = workflowOf(
      await compileGraphToN8n(errorGraph, OPTIONS),
    );
    assert.equal(findNode(errorWorkflow, 'node_agent').onError, 'stopWorkflow');

    const rulesGraph = canaryGraph();
    const rulesAgent = rulesGraph.nodes.find(
      (node) => node.id === 'node_agent',
    );
    assert.ok(rulesAgent);
    rulesAgent.config = { ...rulesAgent.config, fallbackPolicy: 'rules' };
    const rulesResult = await compileGraphToN8n(rulesGraph, OPTIONS);
    assert.equal(rulesResult.ok, true);
    assert.ok(
      rulesResult.issues.some(
        (issue) =>
          issue.level === 'warning' && issue.message.includes('规则备援'),
      ),
    );

    const invalidGraph = canaryGraph();
    const invalidAgent = invalidGraph.nodes.find(
      (node) => node.id === 'node_agent',
    );
    assert.ok(invalidAgent);
    invalidAgent.config = { ...invalidAgent.config, fallbackPolicy: 'silent' };
    const invalidResult = await compileGraphToN8n(invalidGraph, OPTIONS);
    assert.equal(invalidResult.ok, false);
    assert.equal(invalidResult.workflow, null);
    assert.ok(
      invalidResult.issues.some(
        (issue) =>
          issue.level === 'error' && issue.message.includes('fallbackPolicy'),
      ),
    );
  });
});
