/**
 * 连接（Edge）的运行态与自描述标签。
 *
 * 这里回答两个问题，都只依赖**已经观测到的事实**：
 *   1. 这条连接这次运行到底走没走？（`deriveEdgeRunState`）
 *   2. 这条线自己说明白它是哪种连接了吗？（`edgeDisplayLabel`）
 *
 * 为什么必须单独抽出来：旧实现是"源节点 success 就把所有出边染绿"，于是
 * Condition 成功后 true / false 两条分支一起变绿 —— 那不是遥测，是撒谎。
 * 真正的判据要看**下游有没有真的开始执行**。
 *
 * 另外两条保守规则：
 *   - 运行还没定稿时，下游没动静只能算 `waiting`（不知道），不能算 `untaken`；
 *   - 资源连接（model / memory / tool / subworkflow）的下游是"配置"而不是流程
 *     步骤，它们没有事件是正常的，绝不画成"未走分支"。
 */
import type {
  ConnectionKind,
  RuntimeNodeState,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowGraphV1,
} from './types';

export type EdgeRunState =
  | 'idle'
  | 'waiting'
  | 'carrying'
  | 'taken'
  | 'untaken'
  | 'error';

const TERMINAL_STATES = new Set<RuntimeNodeState>([
  'success',
  'error',
  'skipped',
]);

/** 流程连接：它们代表"下一步执行谁"，走没走是有意义的。 */
function isFlowKind(kind: ConnectionKind): boolean {
  return kind === 'main' || kind === 'branch';
}

export function deriveEdgeRunState(input: {
  kind: ConnectionKind;
  sourceState: RuntimeNodeState;
  targetState: RuntimeNodeState;
  /** 这次运行是否已经有遥测（没有的话整张图保持 idle，不猜）。 */
  hasRun: boolean;
  /** 这次运行是否已经定稿（completed / failed）。 */
  runFinished: boolean;
}): EdgeRunState {
  const { kind, sourceState, targetState, hasRun, runFinished } = input;
  if (!hasRun) return 'idle';

  // 失败节点吃进来的那条边是红色的：下游真的挂了，这条连接确实送过数据。
  if (targetState === 'error') return 'error';
  // 源正在跑：这条边就是当前路径，轻量流动。
  if (sourceState === 'running') return 'carrying';
  if (
    sourceState === 'success' &&
    (targetState === 'running' || targetState === 'success')
  ) {
    return 'taken';
  }
  if (targetState === 'skipped') return 'untaken';

  // 还没定稿：下游没动静只能说明"不知道"，不能判成没走。
  if (!runFinished) return 'waiting';

  // 定稿之后：源已经终态、下游从未开始 —— 只有流程连接才说明"这条路没走"。
  if (isFlowKind(kind) && TERMINAL_STATES.has(sourceState)) return 'untaken';
  return 'waiting';
}

export type EdgeRunSummary = {
  total: number;
  idle: number;
  waiting: number;
  carrying: number;
  taken: number;
  untaken: number;
  error: number;
};

export function summarizeEdgeRunStates(
  states: Iterable<EdgeRunState>,
): EdgeRunSummary {
  const summary: EdgeRunSummary = {
    total: 0,
    idle: 0,
    waiting: 0,
    carrying: 0,
    taken: 0,
    untaken: 0,
    error: 0,
  };
  for (const state of states) {
    summary.total += 1;
    summary[state] += 1;
  }
  return summary;
}

const KIND_LABELS: Record<ConnectionKind, string> = {
  main: '主流程',
  branch: '条件分支',
  model: '模型',
  memory: '记忆',
  tool: '工具',
  subworkflow: '子工作流',
};

export function connectionKindLabel(kind: ConnectionKind): string {
  return KIND_LABELS[kind];
}

/**
 * 画在连线上的标签：
 *  - 用户显式写的 label 优先；
 *  - 条件分支显示 true / false；
 *  - 资源连接显示端口名（Model / Memory / Tool …），让颜色之外再有一层语义；
 *  - 普通主流程不写字，避免画布变吵。
 */
export function edgeDisplayLabel(
  graph: Pick<WorkflowGraphV1, 'nodes'>,
  edge: WorkflowGraphEdge,
): string | undefined {
  if (edge.label && edge.label.trim()) return edge.label.trim();
  if (edge.kind === 'branch') {
    return edge.condition?.branch ?? 'branch';
  }
  if (edge.kind === 'main') return undefined;
  const source = graph.nodes.find((node) => node.id === edge.source.nodeId);
  const port = source?.ports.find((item) => item.id === edge.source.portId);
  return port?.label ?? KIND_LABELS[edge.kind];
}

export type EdgeEndpoints = {
  source: WorkflowGraphNode | undefined;
  target: WorkflowGraphNode | undefined;
  sourcePortLabel: string;
  targetPortLabel: string;
  sourceNodeName: string;
  targetNodeName: string;
};

/** 边 Inspector 用：把端口 id 还原成人和校验器都能读懂的名字。 */
export function describeEdgeEndpoints(
  graph: Pick<WorkflowGraphV1, 'nodes'>,
  edge: WorkflowGraphEdge,
): EdgeEndpoints {
  const source = graph.nodes.find((node) => node.id === edge.source.nodeId);
  const target = graph.nodes.find((node) => node.id === edge.target.nodeId);
  return {
    source,
    target,
    sourcePortLabel:
      source?.ports.find((port) => port.id === edge.source.portId)?.label ??
      edge.source.portId,
    targetPortLabel:
      target?.ports.find((port) => port.id === edge.target.portId)?.label ??
      edge.target.portId,
    sourceNodeName: source?.name ?? edge.source.nodeId,
    targetNodeName: target?.name ?? edge.target.nodeId,
  };
}
