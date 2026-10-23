import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeEdge, makeNode } from './helpers/graph';
import {
  connectionKindLabel,
  deriveEdgeRunState,
  describeEdgeEndpoints,
  edgeDisplayLabel,
  summarizeEdgeRunStates,
  type EdgeRunState,
} from '@/lib/workflow-graph/edge-runtime';
import type { RuntimeNodeState } from '@/lib/workflow-graph/types';

function state(input: {
  kind?: Parameters<typeof deriveEdgeRunState>[0]['kind'];
  source: RuntimeNodeState;
  target: RuntimeNodeState;
  hasRun?: boolean;
  runFinished?: boolean;
}): EdgeRunState {
  return deriveEdgeRunState({
    kind: input.kind ?? 'main',
    sourceState: input.source,
    targetState: input.target,
    hasRun: input.hasRun ?? true,
    runFinished: input.runFinished ?? false,
  });
}

describe('连接运行态推导', () => {
  it('没有任何运行时，所有连接保持 idle —— 不猜也不装饰', () => {
    assert.equal(
      state({ source: 'success', target: 'success', hasRun: false }),
      'idle',
    );
    assert.equal(
      state({ source: 'running', target: 'running', hasRun: false }),
      'idle',
    );
  });

  it('源节点正在跑 → carrying（当前路径）', () => {
    assert.equal(state({ source: 'running', target: 'waiting' }), 'carrying');
    assert.equal(state({ source: 'running', target: 'running' }), 'carrying');
  });

  it('源成功且下游真的开始了 → taken', () => {
    assert.equal(state({ source: 'success', target: 'running' }), 'taken');
    assert.equal(
      state({ source: 'success', target: 'success', runFinished: true }),
      'taken',
    );
  });

  it('下游报错 → error（这条边确实送过数据）', () => {
    assert.equal(state({ source: 'success', target: 'error' }), 'error');
    assert.equal(
      state({ source: 'success', target: 'error', runFinished: true }),
      'error',
    );
  });

  it('下游被明确跳过 → untaken', () => {
    assert.equal(state({ source: 'success', target: 'skipped' }), 'untaken');
  });

  it('运行没定稿时，下游没动静只能算 waiting', () => {
    assert.equal(
      state({ source: 'success', target: 'waiting', runFinished: false }),
      'waiting',
    );
  });

  it('运行定稿后，源已终态而下游从未开始 → 这条流程连接没走', () => {
    assert.equal(
      state({ source: 'success', target: 'waiting', runFinished: true }),
      'untaken',
      '这正是 Condition 未走分支该有的样子',
    );
    assert.equal(
      state({ source: 'error', target: 'waiting', runFinished: true }),
      'untaken',
    );
  });

  it('资源连接不谎报未走：模型/工具没有事件是正常的', () => {
    assert.equal(
      state({
        kind: 'model',
        source: 'success',
        target: 'waiting',
        runFinished: true,
      }),
      'waiting',
    );
    assert.equal(
      state({
        kind: 'tool',
        source: 'success',
        target: 'waiting',
        runFinished: true,
      }),
      'waiting',
    );
  });

  it('源节点自己都没被观测到时不判未走', () => {
    assert.equal(
      state({ source: 'waiting', target: 'waiting', runFinished: true }),
      'waiting',
    );
  });
});

describe('连接运行态汇总', () => {
  it('按状态计数并给出总数', () => {
    const summary = summarizeEdgeRunStates([
      'taken',
      'taken',
      'untaken',
      'error',
      'idle',
    ]);
    assert.equal(summary.total, 5);
    assert.equal(summary.taken, 2);
    assert.equal(summary.untaken, 1);
    assert.equal(summary.error, 1);
    assert.equal(summary.idle, 1);
    assert.equal(summary.carrying, 0);
  });
});

describe('连接标签与端口描述', () => {
  const graph = {
    nodes: [
      makeNode('condition', 'node_route', { name: '是否高优先级' }),
      makeNode('aiAgent', 'node_agent', { name: 'AI 主管' }),
      makeNode('llmModel', 'node_model', { name: 'Qwen Plus' }),
    ],
  };

  it('分支连接标出 true / false，主流程不写多余的字', () => {
    const trueEdge = makeEdge('node_route', 'branch.true', 'node_agent', 'main.in', 'branch');
    delete trueEdge.label;
    assert.equal(edgeDisplayLabel(graph, trueEdge), 'true');

    const mainEdge = makeEdge('node_route', 'main.out', 'node_agent', 'main.in');
    assert.equal(edgeDisplayLabel(graph, mainEdge), undefined);
  });

  it('资源连接用端口名自描述，用户自定义标签优先', () => {
    const modelEdge = makeEdge('node_agent', 'resource.model', 'node_model', 'model.provider', 'model');
    assert.equal(edgeDisplayLabel(graph, modelEdge), 'Model');

    assert.equal(
      edgeDisplayLabel(graph, { ...modelEdge, label: '主力模型' }),
      '主力模型',
    );
  });

  it('把端口 id 还原成可读名字，缺失时退回 id 而不是 undefined', () => {
    const edge = makeEdge('node_agent', 'resource.model', 'node_model', 'model.provider', 'model');
    const endpoints = describeEdgeEndpoints(graph, edge);
    assert.equal(endpoints.sourceNodeName, 'AI 主管');
    assert.equal(endpoints.targetNodeName, 'Qwen Plus');
    assert.equal(endpoints.targetPortLabel, 'Model');

    const orphan = makeEdge('missing_node', 'main.out', 'node_model', 'model.provider', 'model');
    const orphanEndpoints = describeEdgeEndpoints(graph, orphan);
    assert.equal(orphanEndpoints.sourceNodeName, 'missing_node');
    assert.equal(orphanEndpoints.sourcePortLabel, 'main.out');
  });

  it('连接类型都有中文名（Inspector 直接展示）', () => {
    assert.equal(connectionKindLabel('branch'), '条件分支');
    assert.equal(connectionKindLabel('tool'), '工具');
  });
});
