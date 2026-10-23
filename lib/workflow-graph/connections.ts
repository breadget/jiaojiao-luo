import type {
  WorkflowGraphEdge,
  WorkflowGraphV1,
} from '@/lib/workflow-graph/types';
import { connectionWouldCreateCycle } from '@/lib/workflow-graph/validate';
import { randomId } from '@/lib/random-id';

export type ConnectionRequest = {
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
  /** 允许调用方指定 id（例如回放固定夹具）；默认随机生成。 */
  edgeId?: string;
};

export type ConnectionCheck =
  | { ok: true; edge: WorkflowGraphEdge }
  | { ok: false; reason: string };

/**
 * 画布上"这两条线能不能连"的唯一判据。
 *
 * 从 components/studio/workflow-studio.tsx 抽出来，是因为这段逻辑同时决定了
 * UI 行为和 Graph 的合法性：只有放在 lib 里，服务端校验和自动化测试才能复用
 * 同一份规则，而不是各写一遍然后慢慢漂移。
 *
 * 顺序很重要 —— 先报"不存在/连自己"，再报"端口不兼容"，
 * 最后才是容量、重复和循环，这样提示信息最贴近用户当时的动作。
 */
export function checkConnection(
  graph: WorkflowGraphV1,
  request: ConnectionRequest,
): ConnectionCheck {
  const source = graph.nodes.find((node) => node.id === request.sourceNodeId);
  const target = graph.nodes.find((node) => node.id === request.targetNodeId);
  if (!source || !target) {
    return { ok: false, reason: '连接指向了不存在的节点。' };
  }
  if (source.id === target.id) {
    return { ok: false, reason: '节点不能连接到自己。' };
  }

  const sourcePort = source.ports.find((port) => port.id === request.sourcePortId);
  const targetPort = target.ports.find((port) => port.id === request.targetPortId);
  if (!sourcePort || !targetPort) {
    return { ok: false, reason: '连接的端口不存在。' };
  }

  const compatible =
    sourcePort.direction === 'output' &&
    targetPort.direction === 'input' &&
    (sourcePort.kind === targetPort.kind ||
      (sourcePort.kind === 'branch' && targetPort.kind === 'main'));
  if (!compatible) {
    return {
      ok: false,
      reason: `${sourcePort.label} 端口不能连接 ${targetPort.label} 端口。`,
    };
  }

  const currentCount = graph.edges.filter(
    (edge) =>
      edge.source.nodeId === source.id && edge.source.portId === sourcePort.id,
  ).length;
  if (
    sourcePort.maxConnections !== null &&
    currentCount >= sourcePort.maxConnections
  ) {
    return {
      ok: false,
      reason: `一个 Agent 只能连接一个 ${sourcePort.label}。`,
    };
  }

  const duplicated = graph.edges.some(
    (edge) =>
      edge.source.nodeId === source.id &&
      edge.source.portId === sourcePort.id &&
      edge.target.nodeId === target.id &&
      edge.target.portId === targetPort.id,
  );
  if (duplicated) {
    return { ok: false, reason: '这两个端口已经连接。' };
  }

  const candidate: WorkflowGraphEdge = {
    id: request.edgeId ?? `edge_${randomId().slice(0, 8)}`,
    kind: sourcePort.kind,
    source: { nodeId: source.id, portId: sourcePort.id },
    target: { nodeId: target.id, portId: targetPort.id },
    ...(sourcePort.kind === 'branch'
      ? { label: sourcePort.label, condition: { branch: sourcePort.label } }
      : {}),
  };

  if (connectionWouldCreateCycle(graph, candidate)) {
    return { ok: false, reason: '这条连接会让主执行链路形成循环。' };
  }

  return { ok: true, edge: candidate };
}
