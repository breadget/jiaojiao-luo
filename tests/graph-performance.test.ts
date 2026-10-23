import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chainGraph, largeGraph } from './helpers/graph';
import { isWorkflowGraphPayload } from '@/lib/workflow-graph/payload';
import { validateGraph } from '@/lib/workflow-graph/validate';

/**
 * 100 节点性能基线。
 *
 * 预算刻意给得很宽（正常实现比它快两个数量级），目的是拦住"某次改动把
 * 复杂度从 O(V+E) 变成 O(V²)/O(V³)"这种量级退化，而不是去卡机器抖动。
 */
const NODE_LIMIT = 100;
const SINGLE_RUN_BUDGET_MS = 200;
const AVERAGE_BUDGET_MS = 40;
const SCALING_FACTOR_LIMIT = 40;
/**
 * 比值的绝对地板。
 *
 * 10 个节点的平均耗时只有几十微秒，比值会被调度抖动放大（小尺寸量到 0.021ms、
 * 大尺寸量到 1.3ms 就能算出 60 倍）。真正的 O(V²)/O(V³) 退化在 100 节点上远不止
 * 5ms，所以"绝对值仍然很小"可以判定为噪声而不是复杂度问题。
 */
const SCALING_NOISE_FLOOR_MS = 5;

function timed<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
}

function averageMs(nodeCount: number, iterations: number): number {
  const graph = largeGraph(nodeCount);
  // 预热，避免把 JIT 首次编译算进基线
  validateGraph(graph);
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) validateGraph(graph);
  return (performance.now() - started) / iterations;
}

/** 多轮取最小值：调度抖动只会让测量变慢，最小值最接近真实成本。 */
function bestMs(nodeCount: number, iterations: number, rounds = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < rounds; round += 1) {
    best = Math.min(best, averageMs(nodeCount, iterations));
  }
  return best;
}

describe('Graph performance baseline', () => {
  it('100 个节点的图通过结构守卫，且没有 error', () => {
    const graph = largeGraph(NODE_LIMIT);
    assert.equal(graph.nodes.length, NODE_LIMIT);
    assert.equal(isWorkflowGraphPayload(graph), true);
    assert.deepEqual(
      validateGraph(graph).filter((issue) => issue.level === 'error'),
      [],
    );
  });

  it('单次校验 100 节点耗时低于预算', () => {
    const graph = largeGraph(NODE_LIMIT);
    validateGraph(graph);
    const { value, ms } = timed(() => validateGraph(graph));
    assert.deepEqual(value, []);
    assert.ok(
      ms < SINGLE_RUN_BUDGET_MS,
      `100 节点单次校验耗时 ${ms.toFixed(2)}ms，超过 ${SINGLE_RUN_BUDGET_MS}ms 预算`,
    );
  });

  it('反复校验 100 节点的平均耗时低于预算', () => {
    const average = averageMs(NODE_LIMIT, 50);
    assert.ok(
      average < AVERAGE_BUDGET_MS,
      `100 节点平均校验耗时 ${average.toFixed(2)}ms，超过 ${AVERAGE_BUDGET_MS}ms 预算`,
    );
  });

  it('规模从 10 涨到 100 节点时耗时不应爆炸式增长', () => {
    const small = Math.max(bestMs(10, 200), 0.02);
    const large = bestMs(NODE_LIMIT, 50);
    const factor = large / small;
    assert.ok(
      factor < SCALING_FACTOR_LIMIT || large < SCALING_NOISE_FLOOR_MS,
      `节点数 ×10 后耗时放大 ${factor.toFixed(1)} 倍，超过 ${SCALING_FACTOR_LIMIT} 倍上限且绝对值不小于 ${SCALING_NOISE_FLOOR_MS}ms（small=${small.toFixed(3)}ms, large=${large.toFixed(3)}ms）`,
    );
  });

  it('结构守卫对 100 节点图同样廉价', () => {
    const graph = largeGraph(NODE_LIMIT);
    isWorkflowGraphPayload(graph);
    const { value, ms } = timed(() => isWorkflowGraphPayload(graph));
    assert.equal(value, true);
    assert.ok(ms < SINGLE_RUN_BUDGET_MS, `结构守卫耗时 ${ms.toFixed(2)}ms`);
  });

  it('恰好 100 节点通过、101 节点被拒（与 API 上限一致）', () => {
    assert.equal(isWorkflowGraphPayload(largeGraph(NODE_LIMIT)), true);
    assert.equal(isWorkflowGraphPayload(largeGraph(NODE_LIMIT + 1)), false);
  });

  it('300 条连接的图上校验仍然是线性量级', () => {
    const graph = chainGraph(['trigger', 'output']);
    const base = graph.edges[0];
    graph.edges = Array.from({ length: 300 }, (_, index) => ({
      ...base,
      id: `edge_${index}`,
    }));
    assert.equal(isWorkflowGraphPayload(graph), true);
    const { ms } = timed(() => validateGraph(graph));
    assert.ok(ms < SINGLE_RUN_BUDGET_MS, `300 连接校验耗时 ${ms.toFixed(2)}ms`);
  });
});
