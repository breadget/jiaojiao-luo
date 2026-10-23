/**
 * Studio 侧的运行遥测折叠。
 *
 * 这里只放**纯函数**：把 `GET /api/runs/:requestId/telemetry?afterSeq=` 的增量分页
 * 折进现有 runtime 快照，并决定下一次轮询该怎么走。抽出来是因为服务端按游标只
 * 折叠**单页**事件，跨页的"终态不被降级"必须由客户端同样守住 —— 而这条规则
 * 值得用 node:test 直接钉住，而不是埋在 React 组件里。
 */
import type { NodeRuntimeSnapshot, RuntimeNodeState } from './types';

/** 与 `/api/runs/:requestId/telemetry` 的响应逐字对应。 */
export type RunTelemetryNodeError = {
  code?: string | null;
  message: string;
  detail?: string | null;
  eventType?: string;
  at?: number;
};

export type RunTelemetryNode = {
  nodeId: string;
  name: string;
  type: string;
  state: RuntimeNodeState;
  durationMs: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  conflicts: number;
  lastEventSeq: number | null;
  /** 失败原因；没失败就是 null。 */
  error?: RunTelemetryNodeError | null;
};

export type RunTelemetryPayload = {
  requestId: string;
  run: {
    id: string;
    status: string;
    workflowId: string;
    executionId?: string | null;
    engine?: string | null;
    mode?: string | null;
    degraded?: boolean | null;
    durationMs?: number | null;
  };
  boundVersionId: string | null;
  boundVersion: number | null;
  bindingCount: number;
  /** prebound = 危险节点之前就报了 executionId；legacy = 只能靠时间窗 fallback。 */
  binding: 'prebound' | 'legacy';
  nodes: RunTelemetryNode[];
  /** 这一页的原始事件（已脱敏）。客户端只用来判断"有没有新东西"。 */
  events: unknown[];
  /** 未映射的 n8n 节点名。展示用，绝不参与状态推导。 */
  unmappedNodes: string[];
  nextSeq: number;
  hasMore: boolean;
};

/** 已经定稿、不会再变的运行状态。`running` / `queued` 都还要继续轮询。 */
const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'canceled',
  'timed_out',
  'timed-out',
  'timeout',
  'skipped',
]);

export function isTerminalRunStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return TERMINAL_RUN_STATUSES.has(status.trim().toLowerCase());
}

const TERMINAL_NODE_STATES = new Set<RuntimeNodeState>([
  'success',
  'error',
  'skipped',
]);

export function isTerminalNodeState(state: RuntimeNodeState): boolean {
  return TERMINAL_NODE_STATES.has(state);
}

/**
 * 状态强度。`waiting` 比 `running` 弱：分页读到的每一页只折叠**当页**事件，
 * 所以第 2 页里"没有事件"的节点会被算成 waiting —— 那只是"这页没它的消息"，
 * 绝不能把第 1 页已经拿到的 running/success 打回去。
 */
const STATE_RANK: Record<RuntimeNodeState, number> = {
  idle: 0,
  waiting: 1,
  running: 2,
  success: 3,
  error: 3,
  skipped: 3,
};

/**
 * 跨页合并节点状态：只允许变强，终态一旦到手不再被后到的 running/waiting
 * 拉回去，终态与终态的冲突以先到的为准。服务端在单页内守同一条规则，
 * 客户端跨页必须自己再守一遍。
 */
export function mergeRuntimeState(
  previous: RuntimeNodeState | undefined,
  incoming: RuntimeNodeState,
): RuntimeNodeState {
  if (!previous) return incoming;
  if (STATE_RANK[incoming] < STATE_RANK[previous]) return previous;
  if (isTerminalNodeState(previous)) return previous;
  return incoming;
}

/** 把一页遥测折进 runtime；未出现在这一页里的节点原样保留。 */
export function applyRunTelemetry(
  previous: Record<string, NodeRuntimeSnapshot>,
  nodes: RunTelemetryNode[],
): Record<string, NodeRuntimeSnapshot> {
  if (!nodes.length) return previous;
  const next: Record<string, NodeRuntimeSnapshot> = { ...previous };
  let changed = false;
  for (const node of nodes) {
    const before = previous[node.nodeId];
    const state = mergeRuntimeState(before?.state, node.state);
    const durationMs = node.durationMs ?? before?.durationMs;
    // 原因只增不减：没有新原因时保留已有的（否则 Inspector 会突然失忆）；
    // 有新的结构化原因就用新的 —— 单页内服务器已保证"先到先得"。
    const error = node.error ?? null;
    const errorMessage = error?.message ?? before?.error;
    const errorCode = error?.code ?? before?.errorCode;
    const errorDetail = error?.detail ?? before?.errorDetail;
    if (
      before &&
      before.state === state &&
      before.durationMs === durationMs &&
      before.error === errorMessage &&
      before.errorCode === errorCode &&
      before.errorDetail === errorDetail
    ) {
      continue;
    }
    changed = true;
    next[node.nodeId] = {
      ...before,
      state,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(errorMessage ? { error: errorMessage } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(errorDetail ? { errorDetail } : {}),
    };
  }
  return changed ? next : previous;
}

export type TelemetrySummary = {
  total: number;
  waiting: number;
  running: number;
  success: number;
  error: number;
  skipped: number;
  idle: number;
  conflicts: number;
};

export function summarizeTelemetry(nodes: RunTelemetryNode[]): TelemetrySummary {
  const summary: TelemetrySummary = {
    total: nodes.length,
    waiting: 0,
    running: 0,
    success: 0,
    error: 0,
    skipped: 0,
    idle: 0,
    conflicts: 0,
  };
  for (const node of nodes) {
    summary[node.state] += 1;
    summary.conflicts += node.conflicts;
  }
  return summary;
}

export type TelemetryPollDecision =
  | { action: 'fetch-more'; afterSeq: number }
  | { action: 'wait'; afterSeq: number; delayMs: number }
  | { action: 'stop'; afterSeq: number; reason: 'settled' | 'timeout' };

export const TELEMETRY_MAX_WAIT_MS = 90_000;
export const TELEMETRY_POLL_INTERVAL_MS = 1_500;

/**
 * 下一次轮询的决定。
 *
 *  - 超过总时限 → 停并标记 timeout：先于翻页判断，避免事件流异常时无限翻页；
 *  - 还有下一页 → 立刻带着 nextSeq 继续拉（不 sleep，避免长分页被拖慢）；
 *  - 运行已经定稿，且整整一轮没拿到新事件 → 停：再等也只是空转；
 *
 * `emptyPolls` 是**包含本轮在内**的连续空轮数，由调用方维护。
 */
export function decideTelemetryPoll(input: {
  payload: Pick<RunTelemetryPayload, 'hasMore' | 'nextSeq' | 'run'>;
  emptyPolls: number;
  elapsedMs: number;
  maxWaitMs?: number;
  intervalMs?: number;
}): TelemetryPollDecision {
  const {
    payload,
    emptyPolls,
    elapsedMs,
    maxWaitMs = TELEMETRY_MAX_WAIT_MS,
    intervalMs = TELEMETRY_POLL_INTERVAL_MS,
  } = input;

  if (elapsedMs >= maxWaitMs) {
    return { action: 'stop', afterSeq: payload.nextSeq, reason: 'timeout' };
  }
  if (payload.hasMore) {
    return { action: 'fetch-more', afterSeq: payload.nextSeq };
  }
  if (isTerminalRunStatus(payload.run.status) && emptyPolls >= 1) {
    return { action: 'stop', afterSeq: payload.nextSeq, reason: 'settled' };
  }
  return { action: 'wait', afterSeq: payload.nextSeq, delayMs: intervalMs };
}
