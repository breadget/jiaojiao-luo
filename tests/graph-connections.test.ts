import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkConnection } from '@/lib/workflow-graph/connections';
import { validateGraph } from '@/lib/workflow-graph/validate';
import {
  chainGraph,
  graphOf,
  makeEdge,
  makeNode,
  validGraph,
} from './helpers/graph';

describe('Graph connection rules', () => {
  it('允许合法的主链路连接，并从源端口推导连接类型', () => {
    const graph = chainGraph(['trigger', 'transform']);
    graph.nodes.push(makeNode('output', 'node_2'));
    const result = checkConnection(graph, {
      sourceNodeId: 'node_1',
      sourcePortId: 'main.out',
      targetNodeId: 'node_2',
      targetPortId: 'main.in',
      edgeId: 'edge_fixed',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.edge.id, 'edge_fixed');
    assert.equal(result.edge.kind, 'main');
  });

  it('拒绝连到不存在的节点或端口', () => {
    const graph = validGraph();
    const ghost = checkConnection(graph, {
      sourceNodeId: 'node_0',
      sourcePortId: 'main.out',
      targetNodeId: 'ghost',
      targetPortId: 'main.in',
    });
    assert.equal(ghost.ok, false);
    if (ghost.ok) return;
    assert.match(ghost.reason, /不存在的节点/);

    const badPort = checkConnection(graph, {
      sourceNodeId: 'node_0',
      sourcePortId: 'main.nope',
      targetNodeId: 'node_1',
      targetPortId: 'main.in',
    });
    assert.equal(badPort.ok, false);
    if (badPort.ok) return;
    assert.match(badPort.reason, /端口不存在/);
  });

  it('拒绝自连接', () => {
    const graph = validGraph();
    const result = checkConnection(graph, {
      sourceNodeId: 'node_1',
      sourcePortId: 'main.out',
      targetNodeId: 'node_1',
      targetPortId: 'main.in',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /不能连接到自己/);
  });

  it('端口容量为 1 时，第二条连接被拒绝', () => {
    const graph = graphOf(
      [
        makeNode('trigger', 'node_0'),
        makeNode('aiAgent', 'agent'),
        makeNode('llmModel', 'model_a'),
        makeNode('llmModel', 'model_b'),
        makeNode('output', 'node_end'),
      ],
      [
        makeEdge('node_0', 'main.out', 'agent', 'main.in'),
        makeEdge('agent', 'main.out', 'node_end', 'main.in'),
        makeEdge('agent', 'resource.model', 'model_a', 'model.provider', 'model'),
      ],
    );
    const result = checkConnection(graph, {
      sourceNodeId: 'agent',
      sourcePortId: 'resource.model',
      targetNodeId: 'model_b',
      targetPortId: 'model.provider',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /只能连接一个/);
  });

  it('Tool 端口一次只连一个 Agent，但 Agent 可以接多个 Tool', () => {
    const graph = graphOf(
      [
        makeNode('trigger', 'node_0'),
        makeNode('aiAgent', 'agent'),
        makeNode('llmModel', 'model_a'),
        makeNode('tool', 'tool_a'),
        makeNode('tool', 'tool_b'),
        makeNode('output', 'node_end'),
      ],
      [
        makeEdge('node_0', 'main.out', 'agent', 'main.in'),
        makeEdge('agent', 'main.out', 'node_end', 'main.in'),
        makeEdge('agent', 'resource.model', 'model_a', 'model.provider', 'model'),
        makeEdge('agent', 'resource.tools', 'tool_a', 'tool.provider', 'tool'),
      ],
    );
    const duplicate = checkConnection(graph, {
      sourceNodeId: 'agent',
      sourcePortId: 'resource.tools',
      targetNodeId: 'tool_a',
      targetPortId: 'tool.provider',
    });
    assert.equal(duplicate.ok, false);
    if (duplicate.ok) return;
    assert.match(duplicate.reason, /已经连接/);

    const secondTool = checkConnection(graph, {
      sourceNodeId: 'agent',
      sourcePortId: 'resource.tools',
      targetNodeId: 'tool_b',
      targetPortId: 'tool.provider',
    });
    assert.equal(secondTool.ok, true);
  });

  it('拒绝端口类型不兼容的连接', () => {
    const graph = graphOf(
      [
        makeNode('trigger', 'node_0'),
        makeNode('aiAgent', 'agent'),
        makeNode('llmModel', 'model_a'),
        makeNode('output', 'node_end'),
      ],
      [
        makeEdge('node_0', 'main.out', 'agent', 'main.in'),
        makeEdge('agent', 'main.out', 'node_end', 'main.in'),
        makeEdge('agent', 'resource.model', 'model_a', 'model.provider', 'model'),
      ],
    );
    const result = checkConnection(graph, {
      sourceNodeId: 'agent',
      sourcePortId: 'resource.model',
      targetNodeId: 'node_end',
      targetPortId: 'main.in',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /不能连接/);
  });

  it('允许 Condition 的 branch 接进 main', () => {
    const graph = chainGraph(['trigger', 'condition', 'output']);
    const result = checkConnection(graph, {
      sourceNodeId: 'node_1',
      sourcePortId: 'branch.false',
      targetNodeId: 'node_2',
      targetPortId: 'main.in',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.edge.kind, 'branch');
    assert.equal(result.edge.condition?.branch, 'false');
  });

  it('拒绝重复连接', () => {
    const graph = validGraph();
    const result = checkConnection(graph, {
      sourceNodeId: 'node_0',
      sourcePortId: 'main.out',
      targetNodeId: 'node_1',
      targetPortId: 'main.in',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /已经连接/);
  });

  it('拒绝会形成循环的连接', () => {
    const graph = chainGraph(['trigger', 'transform', 'transform']);
    const result = checkConnection(graph, {
      sourceNodeId: 'node_2',
      sourcePortId: 'main.out',
      targetNodeId: 'node_1',
      targetPortId: 'main.in',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /循环/);
  });

  it('与 validator 结论一致：checkConnection 放行的连接不会引入 error', () => {
    const graph = chainGraph(['trigger', 'condition', 'transform', 'output']);
    // 先拆掉 projector 自动补的 false 分支，模拟"用户正要从零连一条"
    graph.edges = graph.edges.filter(
      (edge) =>
        !(edge.source.nodeId === 'node_1' && edge.source.portId === 'branch.false'),
    );
    const result = checkConnection(graph, {
      sourceNodeId: 'node_1',
      sourcePortId: 'branch.false',
      targetNodeId: 'node_3',
      targetPortId: 'main.in',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const next = { ...graph, edges: [...graph.edges, result.edge] };
    assert.deepEqual(
      validateGraph(next).filter((issue) => issue.level === 'error'),
      [],
    );
  });
});
