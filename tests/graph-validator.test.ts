import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chainGraph,
  graphOf,
  makeEdge,
  makeNode,
  validGraph,
} from './helpers/graph';
import {
  connectionWouldCreateCycle,
  hasErrors,
  validateGraph,
} from '@/lib/workflow-graph/validate';

function messages(graph: Parameters<typeof validateGraph>[0]) {
  return validateGraph(graph).map((issue) => issue.message);
}

describe('Graph validator', () => {
  it('接受 Trigger → Transform → Output 的最小合法图', () => {
    assert.deepEqual(validateGraph(validGraph()), []);
  });

  it('要求恰好一个 Trigger 入口', () => {
    const noEntry = graphOf(
      [makeNode('trigger', 'node_0'), makeNode('output', 'node_1')],
      [makeEdge('node_0', 'main.out', 'node_1', 'main.in')],
      { entryNodeIds: [] },
    );
    assert.ok(messages(noEntry).some((text) => text.includes('恰好有一个')));

    const twoEntries = chainGraph(['trigger', 'output']);
    twoEntries.nodes.push(makeNode('trigger', 'node_extra', { name: '第二个 Trigger' }));
    twoEntries.entryNodeIds = ['node_0', 'node_extra'];
    assert.ok(messages(twoEntries).some((text) => text.includes('恰好有一个')));
  });

  it('入口必须指向 Trigger，而不是别的节点', () => {
    const graph = chainGraph(['trigger', 'transform', 'output']);
    graph.entryNodeIds = ['node_1'];
    assert.ok(messages(graph).some((text) => text.includes('入口必须指向')));
  });

  it('拒绝指向不存在节点的连接', () => {
    const graph = graphOf(
      [makeNode('trigger', 'node_0'), makeNode('output', 'node_1')],
      [makeEdge('node_0', 'main.out', 'ghost', 'main.in')],
    );
    assert.ok(messages(graph).some((text) => text.includes('不存在的节点')));
  });

  it('检测主链路环路，并允许 DAG', () => {
    const nodes = [
      makeNode('trigger', 'node_0'),
      makeNode('transform', 'node_1'),
      makeNode('output', 'node_2'),
    ];
    const acyclic = graphOf(nodes, [
      makeEdge('node_0', 'main.out', 'node_1', 'main.in'),
      makeEdge('node_1', 'main.out', 'node_2', 'main.in'),
    ]);
    assert.equal(hasErrors(validateGraph(acyclic)), false);

    const cyclic = graphOf(nodes, [
      makeEdge('node_0', 'main.out', 'node_1', 'main.in'),
      makeEdge('node_1', 'main.out', 'node_2', 'main.in'),
      makeEdge('node_2', 'main.out', 'node_0', 'main.in'),
    ]);
    assert.ok(messages(cyclic).some((text) => text.includes('循环')));
  });

  it('connectionWouldCreateCycle 只看 main / branch 连接', () => {
    const graph = chainGraph(['trigger', 'transform', 'output']);
    const back = makeEdge('node_2', 'main.out', 'node_0', 'main.in');
    assert.equal(connectionWouldCreateCycle(graph, back), true);

    const toolEdge = makeEdge(
      'node_2',
      'main.out',
      'node_0',
      'main.in',
      'tool',
    );
    assert.equal(connectionWouldCreateCycle(graph, toolEdge), false);
  });

  it('端口容量超限报错（Agent 的 Model 端口 max=1）', () => {
    const agent = makeNode('aiAgent', 'agent');
    const graph = graphOf(
      [
        makeNode('trigger', 'node_0'),
        agent,
        makeNode('llmModel', 'model_a'),
        makeNode('llmModel', 'model_b'),
        makeNode('output', 'node_end'),
      ],
      [
        makeEdge('node_0', 'main.out', 'agent', 'main.in'),
        makeEdge('agent', 'main.out', 'node_end', 'main.in'),
        makeEdge('agent', 'resource.model', 'model_a', 'model.provider', 'model'),
        makeEdge('agent', 'resource.model', 'model_b', 'model.provider', 'model'),
      ],
    );
    assert.ok(
      messages(graph).some((text) => text.includes('最多只能连接 1 条线')),
    );
  });

  it('输入端口容量同样受限（tool.provider max=1）', () => {
    const graph = graphOf(
      [
        makeNode('trigger', 'node_0'),
        makeNode('aiAgent', 'agent_a'),
        makeNode('aiAgent', 'agent_b'),
        makeNode('llmModel', 'model_a'),
        makeNode('tool', 'tool_a'),
        makeNode('output', 'node_end'),
      ],
      [
        makeEdge('node_0', 'main.out', 'agent_a', 'main.in'),
        makeEdge('agent_a', 'main.out', 'agent_b', 'main.in'),
        makeEdge('agent_b', 'main.out', 'node_end', 'main.in'),
        makeEdge('agent_a', 'resource.model', 'model_a', 'model.provider', 'model'),
        makeEdge('agent_a', 'resource.tools', 'tool_a', 'tool.provider', 'tool'),
        makeEdge('agent_b', 'resource.tools', 'tool_a', 'tool.provider', 'tool'),
      ],
    );
    assert.ok(
      messages(graph).some((text) => text.includes('最多只能连接 1 条线')),
    );
  });

  it('AI Agent 必须连接 Model，未连 Memory 只给 warning', () => {
    const graph = graphOf(
      [makeNode('trigger', 'node_0'), makeNode('aiAgent', 'agent'), makeNode('output', 'node_end')],
      [
        makeEdge('node_0', 'main.out', 'agent', 'main.in'),
        makeEdge('agent', 'main.out', 'node_end', 'main.in'),
      ],
    );
    const issues = validateGraph(graph);
    const model = issues.find((issue) => issue.message.includes('必须连接一个 Model'));
    assert.equal(model?.level, 'error');
    const memory = issues.find((issue) => issue.message.includes('Memory'));
    assert.equal(memory?.level, 'warning');
    assert.equal(hasErrors(issues), true);
    // 缺 Memory 只是 warning，不能被 hasErrors 当成阻断
    assert.equal(
      issues.filter((issue) => issue.level === 'error').length,
      1,
    );
  });

  it('Condition 的 true / false 分支都必须连接', () => {
    const nodes = [
      makeNode('trigger', 'node_0'),
      makeNode('condition', 'node_1'),
      makeNode('output', 'node_2'),
    ];
    const onlyTrue = graphOf(nodes, [
      makeEdge('node_0', 'main.out', 'node_1', 'main.in'),
      makeEdge('node_1', 'branch.true', 'node_2', 'main.in', 'branch'),
    ]);
    assert.ok(messages(onlyTrue).some((text) => text.includes('false 分支尚未连接')));

    const both = graphOf(nodes, [
      makeEdge('node_0', 'main.out', 'node_1', 'main.in'),
      makeEdge('node_1', 'branch.true', 'node_2', 'main.in', 'branch'),
      makeEdge('node_1', 'branch.false', 'node_2', 'main.in', 'branch'),
    ]);
    // 两条 branch 都进 output.main.in；output 的输入端口不限容量，所以不报容量错
    assert.equal(hasErrors(validateGraph(both)), false);
  });

  it('拒绝自环、重复连接、不存在的端口和错误方向', () => {
    const selfLoop = graphOf(
      [makeNode('trigger', 'node_0'), makeNode('transform', 'node_1')],
      [makeEdge('node_1', 'main.out', 'node_1', 'main.in')],
      { entryNodeIds: ['node_0'] },
    );
    assert.ok(messages(selfLoop).some((text) => text.includes('不能连接到自己')));

    const duplicate = graphOf(
      [makeNode('trigger', 'node_0'), makeNode('output', 'node_1')],
      [
        makeEdge('node_0', 'main.out', 'node_1', 'main.in'),
        makeEdge('node_0', 'main.out', 'node_1', 'main.in'),
      ],
    );
    assert.ok(messages(duplicate).some((text) => text.includes('重复连接')));

    const missingPort = graphOf(
      [makeNode('trigger', 'node_0'), makeNode('output', 'node_1')],
      [makeEdge('node_0', 'main.nope', 'node_1', 'main.in')],
    );
    assert.ok(messages(missingPort).some((text) => text.includes('不存在的端口')));

    const wrongDirection = graphOf(
      [makeNode('trigger', 'node_0'), makeNode('output', 'node_1')],
      [makeEdge('node_1', 'main.in', 'node_0', 'main.out')],
    );
    assert.ok(messages(wrongDirection).some((text) => text.includes('方向错误')));
  });

  it('拒绝空名称节点和重复节点 id', () => {
    const blank = chainGraph(['trigger', 'transform', 'output']);
    blank.nodes[1] = { ...blank.nodes[1], name: '   ' };
    assert.ok(messages(blank).some((text) => text.includes('名称不能为空')));

    const duplicated = chainGraph(['trigger', 'output']);
    duplicated.nodes[1] = { ...duplicated.nodes[1], id: 'node_0' };
    assert.ok(messages(duplicated).some((text) => text.includes('重复的节点 id')));
  });

  it('端口 kind 不兼容时报错（Agent 的 Model 端口不能接进 main 输入）', () => {
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
        // 正确的一条已经接上，这里再补一条类型不匹配的
        makeEdge('agent', 'resource.model', 'node_end', 'main.in', 'model'),
      ],
    );
    assert.ok(
      messages(graph).some((text) => text.includes('不能连接')),
    );
  });
});
