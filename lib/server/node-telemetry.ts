/**
 * 节点级遥测：把 n8n 上报的事件折成 Studio 能直接渲染的节点状态。
 *
 * 三条不变量（都有测试守着）：
 *  1. **内部 nodeId 只能来自 `workflow_node_bindings`。** 事件里的 `node` 是 n8n 的
 *     节点 id 或名字；查不到绑定时返回 `null`，调用方必须显式处理"映射缺失"，
 *     绝不能猜一个 nodeId 出来 —— 那正是"前端动画冒充遥测"的老毛病。
 *  2. **状态是事件折叠出来的，不是生成的。** 没有事件就是 `waiting`。
 *  3. **乱序不降级。** 已经终态（success/error/skipped）的节点，后到的 running
 *     事件不会把它打回 running；终态本身以 seq 最小的那个为准，重复终态只记账。
 *
 * 另外所有对外可见的 payload 都要过一遍脱敏与截断：事件来自工作流内部，
 * 里面完全可能夹着 Key、鉴权头或整段模型输出。
 */
import { isSecretKeyName } from '@/lib/workflow-graph/payload';
import type { NodeRuntimeSnapshot, RuntimeNodeState } from '@/lib/workflow-graph/types';

/** 事件里 payload 的序列化上限（与 n8n_events.payload_json 的写入上限一致）。 */
export const PAYLOAD_LIMIT_BYTES = 8_000;
/** 单条消息上限。 */
export const MESSAGE_LIMIT_CHARS = 4_000;
/** 单页事件数上限。 */
export const EVENT_PAGE_LIMIT = 100;
/** 单个字符串字段的截断长度。 */
const STRING_LIMIT_CHARS = 1_000;

export type TelemetryEventRow = {
  /** n8n_events 的隐式 rowid：单调、可直接当游标用。 */
  seq: number;
  request_id: string | null;
  session_id: string | null;
  execution_id: string | null;
  workflow: string | null;
  event_type: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  node: string | null;
  message: string;
  payload_json: string | null;
  duration_ms: number | null;
  created_at: number;
};

export type TelemetryEvent = {
  seq: number;
  requestId: string | null;
  sessionId: string | null;
  executionId: string | null;
  workflow: string | null;
  eventType: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  /** n8n 侧的原始节点标识（id 或名字），脱敏后原样带出便于排错。 */
  externalNode: string | null;
  /** 映射到 Studio 的内部 nodeId；映射缺失时为 null。 */
  internalNodeId: string | null;
  message: string;
  payload: unknown;
  payloadTruncated: boolean;
  durationMs: number | null;
  createdAt: number;
};

export type NodeBinding = {
  internalNodeId: string;
  externalNodeId: string;
  externalNodeName: string;
  role: string;
};

/** 事件类型 → 节点状态。不认识的类型返回 null（只记日志，不改状态）。 */
const EVENT_STATE: Record<string, RuntimeNodeState> = {
  'node.waiting': 'waiting',
  'node.started': 'running',
  'node.start': 'running',
  'node.running': 'running',
  'node.finished': 'success',
  'node.success': 'success',
  'node.completed': 'success',
  'node.error': 'error',
  'node.failed': 'error',
  // 真实失败走全局错误处理器上报，事件里带 node 字段指明是哪个节点炸的。
  // 少了这两行，线上失败在画布上只会停在 waiting —— 状态都不知道，更别提原因。
  'workflow.error': 'error',
  'run.failed': 'error',
  'node.skipped': 'skipped',
};

const TERMINAL_STATES = new Set<RuntimeNodeState>(['success', 'error', 'skipped']);

/** 状态强弱：终态不可被非终态覆盖。 */
function isTerminal(state: RuntimeNodeState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * n8n 节点标识 → 内部 nodeId。
 *
 * 先按 external_node_id 精确匹配，再退回 external_node_name：
 * 不同 n8n 版本在事件里给的字段不一样（有的给节点 id，有的给名字），
 * 两张表都查才算稳。
 */
export function resolveInternalNodeId(
  bindings: NodeBinding[],
  externalNode: string | null | undefined,
): string | null {
  if (!externalNode) return null;
  const needle = externalNode.trim();
  if (!needle) return null;
  const byId = bindings.find((binding) => binding.externalNodeId === needle);
  if (byId) return byId.internalNodeId;
  const byName = bindings.find((binding) => binding.externalNodeName === needle);
  return byName ? byName.internalNodeId : null;
}

// ---------------------------------------------------------------------------
// 脱敏与截断
// ---------------------------------------------------------------------------

function redactValue(value: unknown, depth = 0): { value: unknown; redacted: boolean } {
  if (value === null || value === undefined) return { value: null, redacted: false };
  if (typeof value === 'string') {
    if (value.length > STRING_LIMIT_CHARS) {
      return { value: `${value.slice(0, STRING_LIMIT_CHARS)}…`, redacted: true };
    }
    return { value, redacted: false };
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { value, redacted: false };
  }
  if (depth >= 6) return { value: '[depth-limit]', redacted: true };
  if (Array.isArray(value)) {
    let redacted = false;
    const items = value.slice(0, 50).map((item) => {
      const result = redactValue(item, depth + 1);
      redacted ||= result.redacted;
      return result.value;
    });
    if (value.length > 50) redacted = true;
    return { value: items, redacted };
  }
  if (typeof value === 'object') {
    let redacted = false;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKeyName(key)) {
        out[key] = '[redacted]';
        redacted = true;
        continue;
      }
      const result = redactValue(child, depth + 1);
      redacted ||= result.redacted;
      out[key] = result.value;
    }
    return { value: out, redacted };
  }
  return { value: `[${typeof value}]`, redacted: true };
}

/**
 * 脱敏 + 截断，保证落库/外发的 payload 有界且不含凭据。
 * 返回的 `truncated` 表示"有内容被丢掉了"，UI 需要据此提示而不是假装完整。
 */
export function sanitizeTelemetryPayload(payload: unknown): {
  payload: unknown;
  truncated: boolean;
} {
  if (payload === undefined || payload === null) {
    return { payload: null, truncated: false };
  }
  const { value, redacted } = redactValue(payload);
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? 'null';
  } catch {
    return { payload: '[unserializable]', truncated: true };
  }
  if (serialized.length > PAYLOAD_LIMIT_BYTES) {
    // 留一半预算：preview 里的引号在重新序列化时会被转义，长度最多翻倍，
    // 直接 slice 到上限会让最终 JSON 反而超限。
    const budget = Math.floor(PAYLOAD_LIMIT_BYTES / 2);
    return {
      payload: {
        truncated: true,
        originalLength: serialized.length,
        preview: serialized.slice(0, budget),
      },
      truncated: true,
    };
  }
  return { payload: value, truncated: redacted };
}

export function sanitizeMessage(message: string | null | undefined): string {
  if (!message) return '';
  const text = message.length > MESSAGE_LIMIT_CHARS
    ? `${message.slice(0, MESSAGE_LIMIT_CHARS)}…`
    : message;
  // 消息是自由文本，可能整段粘进一个 Bearer 头
  const { value } = redactValue(text);
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

/**
 * 只声明真正用到的能力。
 *
 * 真实运行时传 `D1Database`，测试传跑在 node:sqlite 上的替身，两者都满足这个结构；
 * 直接写 `D1Database` 会逼着替身去实现 `withSession` / `dump` 这些我们用不到的方法。
 */
export type TelemetryDb = {
  prepare(sql: string): {
    bind(
      ...values: unknown[]
    ): { all<T>(): Promise<{ results?: T[] }> };
  };
};

/** 拉取游标之后的事件，按 seq 升序；这是 SSE / 轮询与"断线重连"的共同底座。 */
export async function listTelemetryEvents(
  db: TelemetryDb,
  options: {
    requestId: string;
    afterSeq?: number;
    limit?: number;
    bindings?: NodeBinding[];
  },
): Promise<TelemetryEvent[]> {
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? 50), 1),
    EVENT_PAGE_LIMIT,
  );
  const afterSeq = Math.max(Math.trunc(options.afterSeq ?? 0), 0);
  const result = await db
    .prepare(
      `SELECT rowid AS seq, request_id, session_id, execution_id, workflow,
              event_type, level, node, message, payload_json, duration_ms, created_at
       FROM n8n_events
       WHERE request_id = ? AND rowid > ?
       ORDER BY rowid ASC
       LIMIT ?`,
    )
    .bind(options.requestId, afterSeq, limit)
    .all<TelemetryEventRow>();
  const bindings = options.bindings ?? [];
  return (result.results ?? []).map((row) => toTelemetryEvent(row, bindings));
}

export function toTelemetryEvent(
  row: TelemetryEventRow,
  bindings: NodeBinding[],
): TelemetryEvent {
  const { payload, truncated } = sanitizeTelemetryPayload(
    row.payload_json ? safeParse(row.payload_json) : null,
  );
  return {
    seq: Number(row.seq),
    requestId: row.request_id,
    sessionId: row.session_id,
    executionId: row.execution_id,
    workflow: row.workflow,
    eventType: row.event_type,
    level: row.level,
    externalNode: row.node,
    internalNodeId: resolveInternalNodeId(bindings, row.node),
    message: sanitizeMessage(row.message),
    payload,
    payloadTruncated: truncated,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// 折叠成节点状态
// ---------------------------------------------------------------------------

export type NodeTelemetry = {
  nodeId: string;
  state: RuntimeNodeState;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  /** 失败原因；只有真的失败过才有值，绝不为了"填满字段"编一个。 */
  error: NodeTelemetryError | null;
  /** 折叠过程中看到的终态冲突次数（乱序 / 重复上报），>0 说明数据可疑。 */
  conflicts: number;
  lastEventSeq: number | null;
};

export type NodeTelemetryError = {
  code: string | null;
  message: string;
  detail: string | null;
  /** 来源事件类型（workflow.error / run.failed / node.error …），排错时要知道信是谁给的。 */
  eventType: string;
  at: number;
};

/** 失败原因的长度上限：够定位问题，又不至于把整段堆栈塞满画布。 */
const ERROR_MESSAGE_LIMIT_CHARS = 400;
const ERROR_DETAIL_LIMIT_CHARS = 800;

function emptyNode(nodeId: string): NodeTelemetry {
  return {
    nodeId,
    state: 'waiting',
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    error: null,
    conflicts: 0,
    lastEventSeq: null,
  };
}

function readErrorText(source: unknown, key: string): string | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readErrorObject(source: unknown): unknown {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const nested = (source as Record<string, unknown>).error;
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested
    : null;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 从失败事件里抽出"为什么失败"。
 *
 * 真实上报有两种形状，都要兜住：
 *   · 全局错误处理器 → payload 直接是 `{ code, message, detail, node, … }`；
 *   · 业务节点自己报错 → payload 里再嵌一层 `error` 对象。
 * 都没有结构化字段时退回事件 message（站点入口已经把它写成 `[CODE] 说明`）。
 * 消息与 detail 都过脱敏与截断：失败详情里完全可能夹着请求头或密钥。
 */
export function extractNodeError(event: TelemetryEvent): NodeTelemetryError {
  const nested = readErrorObject(event.payload) ?? event.payload;
  const code = readErrorText(nested, 'code') ?? readErrorText(event.payload, 'code');
  const detail =
    readErrorText(nested, 'detail') ?? readErrorText(event.payload, 'detail');
  const message =
    readErrorText(nested, 'message') ??
    readErrorText(event.payload, 'message') ??
    event.message ??
    '';
  return {
    code,
    message: clip(
      sanitizeMessage(message) || '节点执行失败，但事件里没有带原因。',
      ERROR_MESSAGE_LIMIT_CHARS,
    ),
    detail: detail ? clip(sanitizeMessage(detail), ERROR_DETAIL_LIMIT_CHARS) : null,
    eventType: event.eventType,
    at: event.createdAt,
  };
}

/**
 * 把事件折叠成每个节点的状态。
 *
 * `nodeIds` 是要展示的节点全集（来自发布版本的绑定），没收到事件的保持 `waiting` ——
 * 这就是"waiting 来自服务端真实状态"而不是前端猜的。
 */
export function projectNodeTelemetry(input: {
  nodeIds: string[];
  bindings: NodeBinding[];
  events: TelemetryEvent[];
}): Map<string, NodeTelemetry> {
  const byNode = new Map<string, NodeTelemetry>();
  for (const nodeId of input.nodeIds) byNode.set(nodeId, emptyNode(nodeId));

  const ordered = [...input.events].sort((a, b) => a.seq - b.seq);
  const unmapped: TelemetryEvent[] = [];

  for (const event of ordered) {
    const nodeId =
      event.internalNodeId ??
      resolveInternalNodeId(input.bindings, event.externalNode);
    if (!nodeId) {
      unmapped.push(event);
      continue;
    }
    // 绑定的 role 可能对应多个内部节点（一对多），事件只带 n8n 侧标识，
    // 所以把状态同时记到该外部节点的所有内部节点上。
    const targets = input.bindings
      .filter(
        (binding) =>
          binding.internalNodeId === nodeId ||
          binding.externalNodeId === event.externalNode ||
          binding.externalNodeName === event.externalNode,
      )
      .map((binding) => binding.internalNodeId);
    const unique = [...new Set(targets.length ? targets : [nodeId])];

    const nextState = EVENT_STATE[event.eventType];
    if (!nextState) continue;

    for (const target of unique) {
      const current = byNode.get(target) ?? emptyNode(target);
      const next = { ...current };
      next.lastEventSeq = event.seq;

      if (isTerminal(current.state)) {
        // 已经终态：只记账，不回退
        if (nextState !== current.state) next.conflicts = current.conflicts + 1;
        byNode.set(target, next);
        continue;
      }

      next.state = nextState;
      if (nextState === 'running' && next.startedAt === null) {
        next.startedAt = event.createdAt;
      }
      if (nextState === 'error' && next.error === null) {
        // 先到的那条失败原因就是原因：后面的重复上报只可能在补细节，换掉反而丢信息。
        next.error = extractNodeError(event);
      }
      if (isTerminal(nextState)) {
        next.finishedAt = event.createdAt;
        const explicit = event.durationMs;
        next.durationMs =
          explicit !== null && explicit !== undefined
            ? Math.max(0, Math.round(explicit))
            : next.startedAt !== null
              ? Math.max(0, event.createdAt - next.startedAt)
              : null;
      }
      byNode.set(target, next);
    }
  }

  return byNode;
}

/** 折叠结果 → Studio 需要的 `NodeRuntimeSnapshot`。 */
export function toRuntimeSnapshot(node: NodeTelemetry): NodeRuntimeSnapshot {
  return {
    state: node.state,
    ...(node.durationMs !== null ? { durationMs: node.durationMs } : {}),
    ...(node.error
      ? {
          error: node.error.message,
          ...(node.error.code ? { errorCode: node.error.code } : {}),
          ...(node.error.detail ? { errorDetail: node.error.detail } : {}),
        }
      : {}),
  };
}

/**
 * 事件流里是否存在"映射缺失"的节点。
 * 有的话说明发布版本的绑定与运行中的工作流不一致，必须显式暴露而不是静默显示 waiting。
 */
export function unmappedExternalNodes(
  bindings: NodeBinding[],
  events: TelemetryEvent[],
): string[] {
  const missing = new Set<string>();
  for (const event of events) {
    if (!event.externalNode) continue;
    if (!resolveInternalNodeId(bindings, event.externalNode)) {
      missing.add(event.externalNode);
    }
  }
  return [...missing].sort();
}

/** 提前绑定的证据事件类型。 */
export const EXECUTION_BOUND_EVENT = 'execution.bound';

/**
 * 这次运行是不是"提前绑定"的？
 *
 *  - `prebound`：收到过 `execution.bound`，说明工作流在危险节点之前就报了
 *    requestId ↔ executionId，节点级映射可以精确到 executionId；
 *  - `legacy`：没有这条证据，只可能是旧工作流 —— 这时仍允许 ±2 分钟时间窗
 *    fallback，但必须把标记带出去，不能假装和 prebound 一样可靠。
 */
export async function executionBindingKind(
  db: TelemetryDb,
  requestId: string,
): Promise<'prebound' | 'legacy'> {
  const statement = db.prepare(
    `SELECT 1 AS hit FROM n8n_events
     WHERE request_id = ? AND event_type = ?
     LIMIT 1`,
  ) as unknown as {
    bind(...values: unknown[]): { first<T>(): Promise<T | null> };
  };
  const row = await statement.bind(requestId, EXECUTION_BOUND_EVENT).first<{
    hit: number;
  }>();
  return row ? 'prebound' : 'legacy';
}
