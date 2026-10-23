import type {
  WorkflowGraphEdge,
  WorkflowGraphV1,
  WorkflowPort,
} from '@/lib/workflow-graph/types';
import { validateAgentConstraints } from '@/lib/workflow-graph/agent-constraints';
import {
  hasLocalDatabaseNodes,
  isLocalDatabaseNode,
  validateLocalDatabaseConfig,
} from '@/lib/workflow-graph/local-database';

export type GraphIssue = {
  level: 'error' | 'warning';
  message: string;
  nodeId?: string;
  edgeId?: string;
};

function hasConnection(graph: WorkflowGraphV1, nodeId: string, portId: string) {
  return graph.edges.some(
    (edge) =>
      (edge.source.nodeId === nodeId && edge.source.portId === portId) ||
      (edge.target.nodeId === nodeId && edge.target.portId === portId),
  );
}

function mainAdjacency(graph: WorkflowGraphV1) {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'main' && edge.kind !== 'branch') continue;
    const targets = adjacency.get(edge.source.nodeId) ?? [];
    targets.push(edge.target.nodeId);
    adjacency.set(edge.source.nodeId, targets);
  }
  return adjacency;
}

function createsCycle(graph: WorkflowGraphV1) {
  const adjacency = mainAdjacency(graph);
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const target of adjacency.get(nodeId) ?? []) {
      if (visit(target)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  return graph.nodes.some((node) => visit(node.id));
}

/** 端口类型是否允许这条连接；branch 可以接进 main。 */
function kindsCompatible(sourcePort: WorkflowPort, targetPort: WorkflowPort) {
  return (
    sourcePort.kind === targetPort.kind ||
    (sourcePort.kind === 'branch' && targetPort.kind === 'main')
  );
}

function portsOf(node: { ports?: WorkflowPort[] }): WorkflowPort[] {
  return Array.isArray(node.ports) ? node.ports : [];
}

/**
 * Graph 的结构校验。
 *
 * 只报"结构上不可能成立"的问题（悬空引用、端口不存在、容量超限、重复连接、
 * 自环、环路），不报"还没画完"。草稿允许半成品，所以 PUT 不因这些错误拒绝保存；
 * Adapter 编译前才把 error 当作硬门槛。
 */
export function validateGraph(graph: WorkflowGraphV1): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

  if (graph.entryNodeIds.length !== 1) {
    issues.push({
      level: 'error',
      message: '第一版工作流必须恰好有一个 Trigger 入口。',
    });
  }

  for (const entryId of graph.entryNodeIds) {
    const entry = nodesById.get(entryId);
    if (!entry || entry.type !== 'trigger') {
      issues.push({
        level: 'error',
        message: '入口必须指向 Trigger 节点。',
        nodeId: entryId,
      });
    }
  }

  if (nodesById.size !== graph.nodes.length) {
    issues.push({
      level: 'error',
      message: '存在重复的节点 id。',
    });
  }

  for (const edge of graph.edges) {
    const source = nodesById.get(edge.source.nodeId);
    const target = nodesById.get(edge.target.nodeId);
    if (!source || !target) {
      issues.push({
        level: 'error',
        message: '连接指向了不存在的节点。',
        edgeId: edge.id,
      });
      continue;
    }

    if (source.id === target.id) {
      issues.push({
        level: 'error',
        message: '节点不能连接到自己。',
        edgeId: edge.id,
        nodeId: source.id,
      });
      continue;
    }

    const sourcePort = portsOf(source).find(
      (port) => port.id === edge.source.portId,
    );
    const targetPort = portsOf(target).find(
      (port) => port.id === edge.target.portId,
    );
    if (!sourcePort || !targetPort) {
      issues.push({
        level: 'error',
        message: '连接使用了节点上不存在的端口。',
        edgeId: edge.id,
      });
      continue;
    }
    if (sourcePort.direction !== 'output' || targetPort.direction !== 'input') {
      issues.push({
        level: 'error',
        message: '连接方向错误：必须从输出端口连到输入端口。',
        edgeId: edge.id,
      });
      continue;
    }
    if (!kindsCompatible(sourcePort, targetPort)) {
      issues.push({
        level: 'error',
        message: `${sourcePort.label} 端口不能连接 ${targetPort.label} 端口。`,
        edgeId: edge.id,
      });
    }
  }

  const seenEdges = new Set<string>();
  for (const edge of graph.edges) {
    const key = `${edge.source.nodeId}::${edge.source.portId}->${edge.target.nodeId}::${edge.target.portId}`;
    if (seenEdges.has(key)) {
      issues.push({
        level: 'error',
        message: '同一对端口之间存在重复连接。',
        edgeId: edge.id,
      });
      continue;
    }
    seenEdges.add(key);
  }

  for (const node of graph.nodes) {
    if (!node.disabled && isLocalDatabaseNode(node)) {
      const databaseError = validateLocalDatabaseConfig(node.config, {
        allowIncomplete: true,
      });
      if (databaseError)
        issues.push({
          level: 'error',
          message: databaseError,
          nodeId: node.id,
        });
    }
    if (!node.name.trim()) {
      issues.push({
        level: 'error',
        message: '节点名称不能为空。',
        nodeId: node.id,
      });
    }

    for (const port of portsOf(node)) {
      if (port.maxConnections === null) continue;
      const used =
        port.direction === 'output'
          ? graph.edges.filter(
              (edge) =>
                edge.source.nodeId === node.id &&
                edge.source.portId === port.id,
            ).length
          : graph.edges.filter(
              (edge) =>
                edge.target.nodeId === node.id &&
                edge.target.portId === port.id,
            ).length;
      if (used > port.maxConnections) {
        issues.push({
          level: 'error',
          message: `${node.name} 的 ${port.label} 端口最多只能连接 ${port.maxConnections} 条线，当前有 ${used} 条。`,
          nodeId: node.id,
        });
      }
    }

    if (node.type === 'aiAgent') {
      const constraintsError = validateAgentConstraints(
        node.config.constraints,
      );
      if (constraintsError) {
        issues.push({
          level: 'error',
          message: constraintsError,
          nodeId: node.id,
        });
      }
      if (!hasConnection(graph, node.id, 'resource.model')) {
        issues.push({
          level: 'error',
          message: 'AI Agent 必须连接一个 Model。',
          nodeId: node.id,
        });
      }
      if (
        !hasConnection(graph, node.id, 'resource.memory') &&
        !hasLocalDatabaseNodes(graph)
      ) {
        issues.push({
          level: 'warning',
          message: 'Agent 尚未连接 Memory，多轮对话不会保留上下文。',
          nodeId: node.id,
        });
      }
    }

    if (node.type === 'condition') {
      for (const portId of ['branch.true', 'branch.false']) {
        if (!hasConnection(graph, node.id, portId)) {
          issues.push({
            level: 'error',
            message: `Condition 的 ${portId.split('.')[1]} 分支尚未连接。`,
            nodeId: node.id,
          });
        }
      }
    }
  }

  if (createsCycle(graph)) {
    issues.push({
      level: 'error',
      message: '主执行链路出现循环；Graph v1 只支持 DAG。',
    });
  }

  return issues;
}

/** 是否存在阻断性错误；Adapter 编译用它做硬门槛。 */
export function hasErrors(issues: GraphIssue[]): boolean {
  return issues.some((issue) => issue.level === 'error');
}

export function connectionWouldCreateCycle(
  graph: WorkflowGraphV1,
  candidate: WorkflowGraphEdge,
) {
  if (candidate.kind !== 'main' && candidate.kind !== 'branch') return false;
  return createsCycle({ ...graph, edges: [...graph.edges, candidate] });
}
