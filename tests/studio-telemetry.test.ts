import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NodeRuntimeSnapshot } from '@/lib/workflow-graph/types';
import {
  applyRunTelemetry,
  decideTelemetryPoll,
  isTerminalRunStatus,
  mergeRuntimeState,
  summarizeTelemetry,
  TELEMETRY_MAX_WAIT_MS,
  type RunTelemetryNode,
  type RunTelemetryPayload,
} from '@/lib/workflow-graph/telemetry';

function node(
  nodeId: string,
  state: RunTelemetryNode['state'],
  overrides: Partial<RunTelemetryNode> = {},
): RunTelemetryNode {
  return {
    nodeId,
    name: `节点 ${nodeId}`,
    type: 'transform',
    state,
    durationMs: null,
    startedAt: null,
    finishedAt: null,
    conflicts: 0,
    lastEventSeq: null,
    ...overrides,
  };
}

function payload(
  overrides: Partial<RunTelemetryPayload> = {},
): RunTelemetryPayload {
  return {
    requestId: 'req_test',
    run: {
      id: 'run_test',
      status: 'completed',
      workflowId: 'wf_test',
    },
    boundVersionId: 'ver_1',
    boundVersion: 3,
    bindingCount: 2,
    binding: 'prebound',
    nodes: [],
    events: [],
    unmappedNodes: [],
    nextSeq: 0,
    hasMore: false,
    ...overrides,
  };
}

describe('运行终态判定', () => {
  it('完成的运行才算终态，queued/running 还要继续轮询', () => {
    assert.equal(isTerminalRunStatus('completed'), true);
    assert.equal(isTerminalRunStatus('FAILED'), true);
    assert.equal(isTerminalRunStatus('running'), false);
    assert.equal(isTerminalRunStatus('queued'), false);
    assert.equal(isTerminalRunStatus(null), false);
    assert.equal(isTerminalRunStatus(''), false);
  });
});

describe('跨页合并节点状态', () => {
  it('第二页的 waiting 不能把第一页的 running/success 打回去', () => {
    // 服务端按游标只折叠当页事件：第 2 页里没有事件的节点会被算成 waiting，
    // 那只是"这页没它的消息"。客户端如果直接覆盖，画布就会在收尾时集体熄灯。
    assert.equal(mergeRuntimeState('running', 'waiting'), 'running');
    assert.equal(mergeRuntimeState('success', 'waiting'), 'success');
    assert.equal(mergeRuntimeState('running', 'idle'), 'running');
  });

  it('允许 waiting → running → success 的正常升级', () => {
    assert.equal(mergeRuntimeState('waiting', 'running'), 'running');
    assert.equal(mergeRuntimeState('running', 'success'), 'success');
    assert.equal(mergeRuntimeState(undefined, 'waiting'), 'waiting');
  });

  it('终态冲突以先到的为准，和 runner 单页内的规则一致', () => {
    assert.equal(mergeRuntimeState('success', 'error'), 'success');
    assert.equal(mergeRuntimeState('error', 'skipped'), 'error');
    assert.equal(mergeRuntimeState('success', 'success'), 'success');
  });
});

describe('把遥测折进 runtime 快照', () => {
  it('只更新这一页出现的节点，未出现的原样保留', () => {
    const previous: Record<string, NodeRuntimeSnapshot> = {
      node_a: { state: 'running' },
      node_b: { state: 'idle' },
    };
    const next = applyRunTelemetry(previous, [
      node('node_a', 'success', { durationMs: 128 }),
    ]);
    assert.deepEqual(next.node_a, { state: 'success', durationMs: 128 });
    assert.deepEqual(next.node_b, { state: 'idle' });
  });

  it('后一页的降级状态不会覆盖已到手的耗时', () => {
    const previous: Record<string, NodeRuntimeSnapshot> = {
      node_a: { state: 'success', durationMs: 128 },
    };
    const next = applyRunTelemetry(previous, [node('node_a', 'waiting')]);
    assert.deepEqual(next.node_a, { state: 'success', durationMs: 128 });
  });

  it('没有实际变化时返回原对象，避免 React 空转重渲染', () => {
    const previous: Record<string, NodeRuntimeSnapshot> = {
      node_a: { state: 'success', durationMs: 128 },
    };
    const same = applyRunTelemetry(previous, [
      node('node_a', 'waiting', { durationMs: 128 }),
    ]);
    assert.equal(same, previous);
    assert.equal(applyRunTelemetry(previous, []), previous);
  });

  it('失败原因会被折进 runtime，并在后续空页里保留', () => {
    const first = applyRunTelemetry({}, [
      node('node_agent', 'error', {
        error: {
          code: 'NODE_ERROR',
          message: "Cannot read properties of undefined (reading 'indexOf')",
          detail: 'at tokenize (evalmachine:20:21)',
        },
      }),
    ]);
    assert.equal(first.node_agent.state, 'error');
    assert.equal(
      first.node_agent.error,
      "Cannot read properties of undefined (reading 'indexOf')",
    );
    assert.equal(first.node_agent.errorCode, 'NODE_ERROR');
    assert.ok(first.node_agent.errorDetail?.includes('tokenize'));

    // 服务端按页折叠：第二页没有这个节点的事件，会把它报成 waiting。
    // 状态不回退，原因更不能丢。
    const second = applyRunTelemetry(first, [node('node_agent', 'waiting')]);
    assert.equal(second, first, '没有新信息时不该产生新对象');
    assert.equal(second.node_agent.state, 'error');
    assert.equal(second.node_agent.error, first.node_agent.error);
  });

  it('失败原因不会被后续的成功状态顺走（终态以先到为准）', () => {
    const errored = applyRunTelemetry({}, [
      node('node_agent', 'error', {
        error: { code: 'NODE_ERROR', message: '先失败' },
      }),
    ]);
    const after = applyRunTelemetry(errored, [node('node_agent', 'success')]);
    assert.equal(after.node_agent.state, 'error');
    assert.equal(after.node_agent.error, '先失败');
  });
});

describe('遥测摘要', () => {
  it('按状态计数并汇总冲突', () => {
    const summary = summarizeTelemetry([
      node('a', 'success', { durationMs: 10 }),
      node('b', 'success', { conflicts: 2 }),
      node('c', 'error', { conflicts: 1 }),
      node('d', 'waiting'),
      node('e', 'skipped'),
    ]);
    assert.equal(summary.total, 5);
    assert.equal(summary.success, 2);
    assert.equal(summary.error, 1);
    assert.equal(summary.waiting, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.conflicts, 3);
  });
});

describe('轮询停止规则', () => {
  it('还有下一页就立刻继续拉，不等间隔', () => {
    const decision = decideTelemetryPoll({
      payload: payload({ hasMore: true, nextSeq: 87 }),
      emptyPolls: 0,
      elapsedMs: 10,
    });
    assert.deepEqual(decision, { action: 'fetch-more', afterSeq: 87 });
  });

  it('运行已终态且整整一轮没有新事件就收工', () => {
    const decision = decideTelemetryPoll({
      payload: payload({ run: { id: 'r', status: 'completed', workflowId: 'w' } }),
      emptyPolls: 1,
      elapsedMs: 1_200,
    });
    assert.deepEqual(decision, {
      action: 'stop',
      afterSeq: 0,
      reason: 'settled',
    });
  });

  it('运行还没定稿时即使这轮为空也继续等', () => {
    const decision = decideTelemetryPoll({
      payload: payload({ run: { id: 'r', status: 'running', workflowId: 'w' } }),
      emptyPolls: 3,
      elapsedMs: 3_000,
      intervalMs: 1_500,
    });
    assert.deepEqual(decision, { action: 'wait', afterSeq: 0, delayMs: 1_500 });
  });

  it('时限优先于翻页，避免异常事件流无限翻页', () => {
    const decision = decideTelemetryPoll({
      payload: payload({ hasMore: true, nextSeq: 500 }),
      emptyPolls: 0,
      elapsedMs: TELEMETRY_MAX_WAIT_MS,
    });
    assert.deepEqual(decision, {
      action: 'stop',
      afterSeq: 500,
      reason: 'timeout',
    });
  });

  it('第一轮只拿到事件但运行已终态时，再等一轮确认没有迟到事件', () => {
    const decision = decideTelemetryPoll({
      payload: payload({ nextSeq: 42 }),
      emptyPolls: 0,
      elapsedMs: 900,
      intervalMs: 1_500,
    });
    assert.deepEqual(decision, { action: 'wait', afterSeq: 42, delayMs: 1_500 });
  });
});
