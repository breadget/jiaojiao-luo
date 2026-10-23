import { buildAgentSystemPrompt } from '@/lib/workflow-graph/agent-constraints';
import {
  canonicalJson,
  hashGraphContent,
  sha256Hex,
} from '@/lib/workflow-graph/hash';
import { findProvider } from '@/lib/llm/providers';
import { findCredentialMaterial } from '@/lib/workflow-graph/payload';
import {
  getLocalDatabaseConnections,
  isLocalDatabaseNode,
  validateLocalDatabaseConfig,
  type LocalDatabaseConnection,
} from '@/lib/workflow-graph/local-database';
import type {
  WorkflowGraphNode,
  WorkflowGraphV1,
} from '@/lib/workflow-graph/types';
import { validateGraph } from '@/lib/workflow-graph/validate';
import type { WorkflowStep } from '@/lib/workflow-types';
import type { AdapterIssue, CompileOptions, CompileResult } from './types';

export const LOCAL_SQLITE_ADAPTER_ID = 'local-sqlite';
export const LOCAL_SQLITE_ADAPTER_VERSION = '1.0.0';

/** A browser and a loopback connection assistant execute this plan; it is never n8n JSON. */
export type LocalSqlitePlan = {
  format: 'urtoris.local-sqlite.v1';
  workflowId: string;
  version: number;
  graphHash: string;
  transport: 'browser-loopback';
  readOnly: true;
  mainNodeIds: string[];
  agent: {
    nodeId: string;
    systemPrompt: string;
    maxIterations: number;
    modelNodeId: string;
    provider: string;
    model: string;
    baseUrl?: string;
    memoryNodeId?: string;
  };
  databases: LocalDatabaseConnection[];
};

export type LocalSqliteCompileResult = Omit<CompileResult, 'workflow'> & {
  workflow: null;
  plan: LocalSqlitePlan | null;
};

export function localSqliteSnapshot(graph: WorkflowGraphV1): WorkflowGraphV1 {
  return {
    ...graph,
    runtime: {
      engine: 'local-sqlite',
      adapter: 'local-sqlite',
      executionMode: 'browser',
      binding: 'draft',
    },
  };
}

function integer(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= max
    ? value
    : fallback;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function localSqliteCompileStats(
  graph: WorkflowGraphV1,
  result: LocalSqliteCompileResult,
) {
  return {
    internalNodes: graph.nodes.filter((node) => !node.disabled).length,
    externalNodes: 0,
    connections: graph.edges.length,
    unsupportedNodes: result.issues.filter(
      (issue) => issue.level === 'error' && issue.message.includes('不支持'),
    ).length,
  };
}

export async function compileGraphToLocalSqlite(
  graph: WorkflowGraphV1,
  options: CompileOptions,
): Promise<LocalSqliteCompileResult> {
  const snapshot = localSqliteSnapshot(graph);
  const graphHash = await hashGraphContent(snapshot);
  const nodes = graph.nodes.filter((node) => !node.disabled);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edges = graph.edges.filter(
    (edge) =>
      nodesById.has(edge.source.nodeId) && nodesById.has(edge.target.nodeId),
  );
  const enabledGraph = { ...graph, nodes, edges };
  const issues: AdapterIssue[] = validateGraph(enabledGraph).map((issue) => ({
    level: issue.level,
    message: issue.message,
    nodeId: issue.nodeId,
  }));
  const allNodeIds = new Set(graph.nodes.map((node) => node.id));
  for (const edge of graph.edges) {
    if (!allNodeIds.has(edge.source.nodeId) || !allNodeIds.has(edge.target.nodeId)) {
      issues.push({ level: 'error', message: '连接指向了不存在的节点。' });
    }
  }
  const supportedTypes = new Set([
    'trigger',
    'aiAgent',
    'llmModel',
    'memory',
    'database',
    'output',
  ]);
  for (const node of nodes) {
    if (!supportedTypes.has(node.type)) {
      issues.push({
        level: 'error',
        nodeId: node.id,
        message: `本机 SQLite 工作流不支持 ${node.type} 节点，请移除该节点或使用独立工作流。`,
      });
    }
    if (node.type === 'database') {
      const error = isLocalDatabaseNode(node)
        ? validateLocalDatabaseConfig(node.config)
        : '本机数据库工作流不能混用服务器数据库。';
      if (error)
        issues.push({ level: 'error', nodeId: node.id, message: error });
    }
  }
  const secretPath = findCredentialMaterial(graph);
  if (secretPath)
    issues.push({
      level: 'error',
      message: `Graph 在 ${secretPath} 含有凭据；本机连接信息只能留在浏览器中。`,
    });

  const agents = nodes.filter((node) => node.type === 'aiAgent');
  const triggers = nodes.filter((node) => node.type === 'trigger');
  const outputs = nodes.filter((node) => node.type === 'output');
  if (agents.length !== 1 || triggers.length !== 1 || outputs.length !== 1) {
    issues.push({
      level: 'error',
      message:
        '本机 SQLite 工作流需要一个 Trigger、一个 AI Agent 和一个 Output。',
    });
  }
  const agent = agents[0];
  const modelEdges = agent
    ? edges.filter(
        (edge) =>
          edge.kind === 'model' &&
          edge.source.nodeId === agent.id &&
          edge.source.portId === 'resource.model',
      )
    : [];
  const model =
    modelEdges.length === 1
      ? nodesById.get(modelEdges[0].target.nodeId)
      : undefined;
  if (
    !model ||
    model.type !== 'llmModel' ||
    !text(model.config.model) ||
    !findProvider(text(model.config.provider))
  ) {
    issues.push({
      level: 'error',
      nodeId: agent?.id,
      message: 'AI Agent 必须连接一个填写了有效服务商和模型名的 Model。',
    });
  }
  if (
    model &&
    model.config.baseUrl !== undefined &&
    model.config.baseUrl !== ''
  ) {
    try {
      const url = new URL(text(model.config.baseUrl));
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
    } catch {
      issues.push({
        level: 'error',
        nodeId: model.id,
        message: '模型地址必须是没有账号、密码或查询参数的 http/https 地址。',
      });
    }
  }

  const mainNodeIds: string[] = [];
  let cursor = graph.entryNodeIds[0];
  const visited = new Set<string>();
  while (cursor && nodesById.has(cursor) && !visited.has(cursor)) {
    visited.add(cursor);
    mainNodeIds.push(cursor);
    const outgoing = edges.filter(
      (edge) =>
        edge.source.nodeId === cursor &&
        (edge.kind === 'main' || edge.kind === 'branch'),
    );
    const node = nodesById.get(cursor)!;
    if (node.type === 'output') {
      if (outgoing.length)
        issues.push({
          level: 'error',
          nodeId: cursor,
          message: 'Output 必须是本机工作流的终点。',
        });
      break;
    }
    if (
      !['trigger', 'aiAgent', 'database'].includes(node.type) ||
      outgoing.length !== 1 ||
      outgoing[0]?.kind !== 'main'
    ) {
      issues.push({
        level: 'error',
        nodeId: cursor,
        message:
          '本机 SQLite 工作流的主链必须从 Trigger 连到 AI Agent，再到 Output；兼容主链数据库，暂不支持分支。',
      });
      break;
    }
    cursor = outgoing[0].target.nodeId;
  }
  if (
    !agent ||
    !visited.has(agent.id) ||
    !outputs[0] ||
    !visited.has(outputs[0].id)
  ) {
    issues.push({
      level: 'error',
      message: 'AI Agent 和 Output 必须位于 Trigger 可达的完整主链。',
    });
  }
  const reachable = new Set(visited);
  for (const edge of edges) {
    if (edge.kind !== 'main' && visited.has(edge.source.nodeId))
      reachable.add(edge.target.nodeId);
  }
  for (const node of nodes) {
    if (!reachable.has(node.id))
      issues.push({
        level: 'error',
        nodeId: node.id,
        message: `${node.name} 没有从 Trigger 可达的连接。`,
      });
  }
  const databases = getLocalDatabaseConnections(enabledGraph);
  if (!databases.length)
    issues.push({
      level: 'error',
      message: '本机工作流至少需要一个填写了文件位置的 SQLite 数据库。',
    });
  for (const database of databases) {
    if (
      !agent ||
      database.agentNodeIds.length !== 1 ||
      database.agentNodeIds[0] !== agent.id
    ) {
      issues.push({
        level: 'error',
        nodeId: database.nodeId,
        message:
          '请将数据库连接到 AI Agent 的 Tools 端口，或保留在该 Agent 的主链上。',
      });
    }
  }
  for (const edge of edges) {
    const source = nodesById.get(edge.source.nodeId)!;
    const target = nodesById.get(edge.target.nodeId)!;
    if (edge.kind === 'main') {
      if (!visited.has(source.id) || !visited.has(target.id))
        issues.push({
          level: 'error',
          nodeId: source.id,
          message: '本机工作流不支持额外的主执行链。',
        });
    } else if (
      source.type !== 'aiAgent' ||
      !(
        (edge.kind === 'model' && target.type === 'llmModel') ||
        (edge.kind === 'memory' && target.type === 'memory') ||
        (edge.kind === 'tool' && target.type === 'database')
      )
    ) {
      issues.push({
        level: 'error',
        nodeId: target.id,
        message:
          '本机工作流只支持 Agent 的 Model、Memory 和 Database 工具连接。',
      });
    }
  }

  const base = {
    ok: false,
    adapter: LOCAL_SQLITE_ADAPTER_ID,
    adapterVersion: LOCAL_SQLITE_ADAPTER_VERSION,
    workflow: null,
    plan: null,
    bindings: [],
    compiledJson: null,
    compiledHash: null,
    graphHash,
    issues,
    requiredCredentialRefs: [],
  } satisfies LocalSqliteCompileResult;
  if (issues.some((issue) => issue.level === 'error') || !agent || !model)
    return base;
  const memory = edges.find(
    (edge) => edge.kind === 'memory' && edge.source.nodeId === agent.id,
  );
  const plan: LocalSqlitePlan = {
    format: 'urtoris.local-sqlite.v1',
    workflowId: options.workflowId,
    version: options.version,
    graphHash,
    transport: 'browser-loopback',
    readOnly: true,
    mainNodeIds,
    agent: {
      nodeId: agent.id,
      systemPrompt: buildAgentSystemPrompt(agent.config),
      maxIterations: integer(agent.config.maxIterations, 6, 50),
      modelNodeId: model.id,
      provider: text(model.config.provider),
      model: text(model.config.model),
      ...(model.config.baseUrl ? { baseUrl: text(model.config.baseUrl) } : {}),
      ...(memory ? { memoryNodeId: memory.target.nodeId } : {}),
    },
    databases,
  };
  const compiledJson = canonicalJson(plan);
  return {
    ...base,
    ok: true,
    plan,
    compiledJson,
    compiledHash: await sha256Hex(compiledJson),
  };
}

/** Compatibility projection for the consumer workflow picker; file paths stay out of public steps. */
export function localSqlitePublishedSteps(
  graph: WorkflowGraphV1,
  plan: LocalSqlitePlan,
): WorkflowStep[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const ids: string[] = [];
  for (const id of plan.mainNodeIds) {
    ids.push(id);
    if (id === plan.agent.nodeId) {
      ids.push(
        ...plan.databases
          .map((item) => item.nodeId)
          .filter((databaseId) => !plan.mainNodeIds.includes(databaseId)),
      );
    }
  }
  return ids.map((id) => {
    const node = nodes.get(id) as WorkflowGraphNode;
    return {
      id: `step_${id}`,
      title: node.name,
      detail: node.description,
      kind:
        node.type === 'trigger'
          ? 'input'
          : node.type === 'aiAgent'
            ? 'compose'
            : node.type === 'output'
              ? 'output'
              : 'transform',
    };
  });
}
