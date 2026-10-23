import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { legacySteps, legacyWorkflow, step } from './helpers/graph';
import { projectLegacyWorkflow } from '@/lib/workflow-graph/project-legacy';
import { validateGraph } from '@/lib/workflow-graph/validate';

describe('Legacy projector', () => {
  it('把 WorkflowStep.kind 映射成对应的 Graph 节点类型', () => {
    const graph = projectLegacyWorkflow(legacyWorkflow());
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    assert.equal(byId.get('node_step_intake')?.type, 'trigger');
    assert.equal(byId.get('node_step_clean')?.type, 'transform');
    assert.equal(byId.get('node_step_route')?.type, 'condition');
    assert.equal(byId.get('node_step_agent')?.type, 'aiAgent');
    assert.equal(byId.get('node_step_output')?.type, 'output');
  });

  it('保留旧步骤身份，便于回写 legacy steps', () => {
    const graph = projectLegacyWorkflow(legacyWorkflow());
    const agent = graph.nodes.find((node) => node.type === 'aiAgent');
    assert.equal(agent?.config.legacyStepId, 'step_agent');
    assert.equal(agent?.config.legacyStepKind, 'compose');
    assert.equal(graph.metadata.source, 'legacy-steps');
    assert.equal(graph.revision, 0);
  });

  it('入口指向第一个步骤生成的 Trigger', () => {
    const graph = projectLegacyWorkflow(legacyWorkflow());
    assert.deepEqual(graph.entryNodeIds, ['node_step_intake']);
  });

  it('按顺序连出主链路', () => {
    const graph = projectLegacyWorkflow(legacyWorkflow());
    const pairs = graph.edges.map(
      (edge) => `${edge.source.nodeId}->${edge.target.nodeId}`,
    );
    assert.ok(pairs.includes('node_step_intake->node_step_clean'));
    assert.ok(pairs.includes('node_step_clean->node_step_route'));
    assert.ok(pairs.includes('node_step_agent->node_step_output'));
  });

  it('decision 生成 true / false 两条分支，false 落到最后的 output', () => {
    const graph = projectLegacyWorkflow(legacyWorkflow());
    const branches = graph.edges.filter(
      (edge) => edge.source.nodeId === 'node_step_route',
    );
    assert.equal(branches.length, 2);
    const trueEdge = branches.find((edge) => edge.source.portId === 'branch.true');
    const falseEdge = branches.find((edge) => edge.source.portId === 'branch.false');
    assert.equal(trueEdge?.target.nodeId, 'node_step_agent');
    assert.equal(falseEdge?.target.nodeId, 'node_step_output');
    assert.equal(trueEdge?.condition?.branch, 'true');
    assert.equal(falseEdge?.condition?.branch, 'false');
  });

  it('compose 步骤自动补上 Model / Memory / 两个 Tool 资源', () => {
    const graph = projectLegacyWorkflow(legacyWorkflow());
    const agent = graph.nodes.find((node) => node.type === 'aiAgent');
    assert.ok(agent);
    const resources = graph.nodes.filter((node) =>
      ['llmModel', 'memory', 'tool'].includes(node.type),
    );
    assert.equal(resources.length, 4);
    const resourceEdges = graph.edges.filter(
      (edge) =>
        edge.source.nodeId === agent.id &&
        edge.source.portId.startsWith('resource.'),
    );
    assert.equal(resourceEdges.length, 4);
    assert.equal(
      resourceEdges.filter((edge) => edge.source.portId === 'resource.tools')
        .length,
      2,
    );
  });

  it('投影结果必须是零问题的合法图（回归护栏）', () => {
    const graph = projectLegacyWorkflow(legacyWorkflow());
    assert.deepEqual(validateGraph(graph), []);
  });

  it('Output 之后还有旧步骤时断开主链，不产生"从不存在端口出发"的悬空边', () => {
    const graph = projectLegacyWorkflow(
      legacyWorkflow([
        step('input', 's1'),
        step('compose', 's2'),
        step('output', 's3'),
        step('transform', 's4'),
      ]),
    );
    const outputId = 'node_s3';
    const dangling = graph.edges.filter(
      (edge) => edge.source.nodeId === outputId,
    );
    assert.deepEqual(dangling, [], 'Output 没有 main.out，不能作为任何连线的起点');
    assert.deepEqual(
      validateGraph(graph).map((issue) => issue.message),
      [],
      '投影结果必须仍然是零问题合法图',
    );

    assert.equal(
      graph.nodes.some((node) => node.id === 'node_s4'),
      false,
      'Output 之后的旧步骤不投影到画布',
    );
    assert.equal(
      graph.nodes.find((node) => node.id === outputId)?.type,
      'output',
      'Output 仍然是终点',
    );
  });

  it('没有 output 步骤时，Condition 的 false 分支悬空会被 validator 指出', () => {
    const graph = projectLegacyWorkflow(
      legacyWorkflow([
        step('input', 's1'),
        step('decision', 's2'),
        step('transform', 's3'),
      ]),
    );
    const messages = validateGraph(graph).map((issue) => issue.message);
    assert.ok(messages.some((text) => text.includes('false 分支尚未连接')));
  });

  it('空草稿退化为单个 Trigger，而不是抛异常', () => {
    const graph = projectLegacyWorkflow(legacyWorkflow([]));
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0].type, 'trigger');
    assert.deepEqual(graph.entryNodeIds, [graph.nodes[0].id]);
    assert.deepEqual(validateGraph(graph), []);
  });

  it('按是否绑定 webhook 决定 runtime.binding', () => {
    const bound = projectLegacyWorkflow(legacyWorkflow());
    assert.equal(bound.runtime.binding, 'external');
    const unbound = projectLegacyWorkflow(
      legacyWorkflow(legacySteps(), { n8nWebhookUrl: null }),
    );
    assert.equal(unbound.runtime.binding, 'draft');
  });

  it('为每个旧步骤生成唯一的连接 id', () => {
    const graph = projectLegacyWorkflow(legacyWorkflow());
    const ids = graph.edges.map((edge) => edge.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
