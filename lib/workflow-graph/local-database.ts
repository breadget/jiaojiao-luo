import type {
  WorkflowGraphNode,
  WorkflowGraphV1,
} from '@/lib/workflow-graph/types';

export const LOCAL_DATABASE_PATH_MAX_LENGTH = 2_048;
export const LOCAL_DATABASE_MAX_ROWS = 500;
export const LOCAL_DATABASE_DEFAULT_MAX_ROWS = 100;

export type LocalDatabaseConnection = {
  nodeId: string;
  name: string;
  filePath: string;
  maxRows: number;
  agentNodeIds: string[];
};

/** Legacy server database nodes without an explicit local configuration stay legacy. */
export function isLocalDatabaseNode(node: WorkflowGraphNode): boolean {
  return (
    node.type === 'database' &&
    (node.config.location === 'local' ||
      node.config.provider === 'sqlite' ||
      Object.hasOwn(node.config, 'filePath'))
  );
}

export function hasLocalDatabaseNodes(graph: WorkflowGraphV1): boolean {
  return graph.nodes.some(
    (node) => !node.disabled && isLocalDatabaseNode(node),
  );
}

export function validateLocalDatabaseConfig(
  config: Record<string, unknown>,
  options: { allowIncomplete?: boolean } = {},
): string | null {
  if (config.provider !== 'sqlite' || config.location !== 'local') {
    return '本机数据库必须使用 SQLite 文件，location 为 local。';
  }
  if (config.operation !== 'select') {
    return '本机数据库目前只允许查询，不能新增、修改或删除数据。';
  }
  if (
    typeof config.filePath !== 'string' ||
    config.filePath.length > LOCAL_DATABASE_PATH_MAX_LENGTH
  ) {
    return `数据库文件位置必须是最多 ${LOCAL_DATABASE_PATH_MAX_LENGTH} 个字符的字符串。`;
  }
  const filePath = config.filePath.trim();
  if (!filePath && options.allowIncomplete)
    return validateMaxRows(config.maxRows);
  if (!filePath) return '请填写电脑中 SQLite 数据库文件的完整位置。';
  if (
    Array.from(filePath).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return '数据库文件位置不能包含换行或控制字符。';
  if (!filePath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(filePath)) {
    return '请填写完整的本机文件位置，例如 /Users/me/data/orders.db 或 C:\\data\\orders.sqlite。';
  }
  if (filePath.split(/[\\/]/).some((segment) => segment === '..')) {
    return '数据库文件位置不能包含 ..，请填写文件的完整位置。';
  }
  if (!/\.(?:db|sqlite|sqlite3)$/i.test(filePath)) {
    return '数据库文件必须以 .db、.sqlite 或 .sqlite3 结尾。';
  }
  return validateMaxRows(config.maxRows);
}

function validateMaxRows(value: unknown): string | null {
  return value !== undefined &&
    (typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > LOCAL_DATABASE_MAX_ROWS)
    ? `每次查询最多返回行数必须是 1–${LOCAL_DATABASE_MAX_ROWS} 的整数。`
    : null;
}

/** Tool edges are authoritative. A legacy DB on the main chain belongs only to its reachable Agent. */
export function getLocalDatabaseConnections(
  graph: WorkflowGraphV1,
): LocalDatabaseConnection[] {
  const activeNodes = new Map(
    graph.nodes.filter((node) => !node.disabled).map((node) => [node.id, node]),
  );
  const mainEdges = graph.edges.filter(
    (edge) =>
      edge.kind === 'main' &&
      activeNodes.has(edge.source.nodeId) &&
      activeNodes.has(edge.target.nodeId),
  );
  const mainReachable = new Set(
    graph.entryNodeIds.filter((id) => activeNodes.has(id)),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of mainEdges) {
      if (
        mainReachable.has(edge.source.nodeId) &&
        !mainReachable.has(edge.target.nodeId)
      ) {
        mainReachable.add(edge.target.nodeId);
        changed = true;
      }
    }
  }
  const mainAgents = graph.nodes.filter(
    (node) =>
      !node.disabled && node.type === 'aiAgent' && mainReachable.has(node.id),
  );
  return graph.nodes
    .filter(
      (node) =>
        !node.disabled &&
        isLocalDatabaseNode(node) &&
        validateLocalDatabaseConfig(node.config) === null,
    )
    .map((node) => {
      const attachedAgentIds = graph.edges
        .filter(
          (edge) =>
            edge.kind === 'tool' &&
            edge.source.portId === 'resource.tools' &&
            edge.target.nodeId === node.id &&
            edge.target.portId === 'tool.provider' &&
            activeNodes.get(edge.source.nodeId)?.type === 'aiAgent' &&
            mainReachable.has(edge.source.nodeId),
        )
        .map((edge) => edge.source.nodeId);
      const agentNodeIds = attachedAgentIds.length
        ? attachedAgentIds
        : mainReachable.has(node.id) && mainAgents.length === 1
          ? [mainAgents[0].id]
          : [];
      return {
        nodeId: node.id,
        name: node.name,
        filePath: (node.config.filePath as string).trim(),
        maxRows:
          typeof node.config.maxRows === 'number'
            ? node.config.maxRows
            : LOCAL_DATABASE_DEFAULT_MAX_ROWS,
        agentNodeIds: [...new Set(agentNodeIds)],
      };
    });
}
