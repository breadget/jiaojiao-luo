import {
  canonicalJson,
  graphContentForHash,
  hashGraphContent,
  sha256Hex,
} from '@/lib/workflow-graph/hash';
import {
  findCredentialMaterial,
  isSecretKeyName,
  isWorkflowGraphPayload,
} from '@/lib/workflow-graph/payload';
import { validateGraph } from '@/lib/workflow-graph/validate';
import type { WorkflowGraphV1 } from '@/lib/workflow-graph/types';
import type { WorkflowStep } from '@/lib/workflow-types';
import type { ProgramPlan } from '@/lib/workflow-program/types';
import {
  normalizeInputFields,
  normalizeProgramArtifact,
  parseMapping,
  parsePredicate,
  validateValueTemplate,
} from '@/lib/workflow-program/values';
import type {
  AdapterIssue,
  CompileOptions,
  CompileResult,
  CompileStats,
} from './types';

export const PROGRAM_ADAPTER_ID = 'program-v1';
export const PROGRAM_ADAPTER_VERSION = '1.0.0';
export const PROGRAM_MAX_NODES = 64;
const executionTypes = new Set([
  'trigger',
  'courseKnowledge',
  'aiAgent',
  'condition',
  'transform',
  'output',
]);
const resourceTypes = new Set(['llmModel', 'memory']);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function hasEmbeddedUrlCredentials(value: unknown): boolean {
  if (typeof value === 'string') {
    try {
      const url = new URL(value);
      return Boolean(
        url.username ||
        url.password ||
        [...url.searchParams.keys()].some(isSecretKeyName),
      );
    } catch {
      return false;
    }
  }
  return Boolean(
    value &&
    typeof value === 'object' &&
    Object.values(value).some(hasEmbeddedUrlCredentials),
  );
}

export type ProgramCompileResult = Omit<CompileResult, 'workflow'> & {
  workflow: null;
  plan: ProgramPlan | null;
};

/** Normalize saved content so previews, publication and service revalidation agree. */
export function programSnapshot(graph: WorkflowGraphV1): WorkflowGraphV1 {
  const snapshot = graphContentForHash(graph);
  return {
    ...snapshot,
    nodes: [...snapshot.nodes].sort((a, b) => compare(a.id, b.id)),
    edges: [...snapshot.edges].sort((a, b) => compare(a.id, b.id)),
    runtime: {
      engine: 'program',
      adapter: PROGRAM_ADAPTER_ID,
      executionMode: 'server',
      binding: 'draft',
    },
  };
}

export async function compileGraphToProgram(
  graph: WorkflowGraphV1,
  options: CompileOptions,
): Promise<ProgramCompileResult> {
  if (!isWorkflowGraphPayload(graph))
    return {
      ok: false,
      adapter: PROGRAM_ADAPTER_ID,
      adapterVersion: PROGRAM_ADAPTER_VERSION,
      workflow: null,
      plan: null,
      bindings: [],
      compiledJson: null,
      compiledHash: null,
      graphHash: await sha256Hex(canonicalJson(graph ?? null)),
      issues: [{ level: 'error', message: '程序画布结构无效。' }],
      requiredCredentialRefs: [],
    };
  const snapshot = programSnapshot(graph);
  const graphHash = await hashGraphContent(snapshot);
  const issues: AdapterIssue[] = [];
  const error = (message: string, nodeId?: string) =>
    issues.push({ level: 'error', message, ...(nodeId ? { nodeId } : {}) });
  if (
    !options.workflowId ||
    !Number.isInteger(options.version) ||
    options.version < 1
  )
    error('程序必须绑定有效的工作流和发布版本。');
  if (snapshot.nodes.length > PROGRAM_MAX_NODES)
    error(`第一版程序最多支持 ${PROGRAM_MAX_NODES} 个节点。`);
  const credentialPath = findCredentialMaterial(snapshot);
  if (credentialPath)
    error(`画布在 ${credentialPath} 含有凭据；请使用站点共用的模型设置。`);
  if (hasEmbeddedUrlCredentials(snapshot))
    error('画布地址不能包含账号、密码或凭据查询参数。');
  const nodes = snapshot.nodes.filter((node) => !node.disabled);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = snapshot.edges.filter(
    (edge) => byId.has(edge.source.nodeId) && byId.has(edge.target.nodeId),
  );
  issues.push(...validateGraph({ ...snapshot, nodes, edges }));
  for (const edge of snapshot.edges) {
    if (
      !snapshot.nodes.some((node) => node.id === edge.source.nodeId) ||
      !snapshot.nodes.some((node) => node.id === edge.target.nodeId)
    )
      error('连接指向了不存在的节点。');
  }
  const flowEdges = edges.filter(
    (edge) => edge.kind === 'main' || edge.kind === 'branch',
  );
  const adjacency = (id: string) =>
    flowEdges.filter((edge) => edge.source.nodeId === id);
  const inputFields = (() => {
    try {
      return normalizeInputFields(
        byId.get(snapshot.entryNodeIds[0])?.config.inputFields,
      );
    } catch (cause) {
      error(
        cause instanceof Error ? cause.message : '输入字段无效。',
        snapshot.entryNodeIds[0],
      );
      return [];
    }
  })();
  if (nodes.filter((node) => node.type === 'trigger').length !== 1)
    error('程序需要恰好一个 Trigger。');
  for (const node of nodes) {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(node.id) ||
      ['__proto__', 'constructor', 'prototype'].includes(node.id)
    )
      error(
        '程序节点 id 只能使用字母、数字、下划线和短横线，不能使用原型属性名称。',
        node.id,
      );
    if (!executionTypes.has(node.type) && !resourceTypes.has(node.type))
      error(
        `第一版程序不支持 ${node.type} 节点；请移除或使用独立工作流。`,
        node.id,
      );
    if (
      ['code', 'script', 'javascript', 'python', 'function'].some((key) =>
        Object.hasOwn(node.config, key),
      )
    )
      error('第一版程序不支持执行任意代码。', node.id);
    const incoming = flowEdges.filter((edge) => edge.target.nodeId === node.id);
    const outgoing = adjacency(node.id);
    if (resourceTypes.has(node.type) && (incoming.length || outgoing.length))
      error('Model 和 Memory 只能通过资源端口连接 Agent。', node.id);
    if (incoming.length > 1)
      error(
        '第一版程序不支持分支汇合；请让每个分支连接独立的 Output。',
        node.id,
      );
    if (executionTypes.has(node.type)) {
      if (node.type === 'output') {
        if (outgoing.length) error('Output 必须是执行路径的终点。', node.id);
      } else if (node.type === 'condition') {
        if (
          outgoing.length !== 2 ||
          !['true', 'false'].every(
            (branch) =>
              outgoing.filter(
                (edge) =>
                  edge.kind === 'branch' &&
                  edge.source.portId === `branch.${branch}` &&
                  (!edge.condition || edge.condition.branch === branch),
              ).length === 1,
          )
        )
          error('Condition 必须各有一条 true 和 false 分支。', node.id);
      } else if (outgoing.length !== 1 || outgoing[0].kind !== 'main')
        error('该节点需要一条 Main 连接；分支只能由 Condition 发出。', node.id);
      if (node.type !== 'trigger' && incoming.length !== 1)
        error('执行节点必须有一个上游节点。', node.id);
      if (node.type === 'trigger' && incoming.length)
        error('Trigger 不能有上游节点。', node.id);
    }
    try {
      if (node.type === 'transform') parseMapping(node.config.mapping ?? {});
      if (node.type === 'condition') parsePredicate(node.config);
      if (node.type === 'courseKnowledge') {
        const query = node.config.query ?? '$json.message';
        if (typeof query !== 'string' || !query.trim() || query.length > 2_000)
          throw new Error(
            '课程检索 query 需要 1–2000 字的文本或变量模板；运行时替换变量后的查询也不能超过 2000 字。',
          );
        validateValueTemplate(query);
        const count = node.config.maxSources;
        if (
          count !== undefined &&
          !(
            typeof count === 'number' &&
            Number.isInteger(count) &&
            count >= 1 &&
            count <= 20
          ) &&
          !(typeof count === 'string' && /^\{\{.+\}\}$/.test(count))
        )
          throw new Error('资料条数必须是 1–20 的整数或变量引用。');
        validateValueTemplate(count);
      }
      if (node.type === 'aiAgent') {
        const prompt = node.config.prompt ?? '$json.message';
        if (typeof prompt !== 'string' || !prompt.trim())
          throw new Error('Agent 的 prompt 必须是非空文本或变量模板。');
        validateValueTemplate(prompt);
        if (
          typeof node.config.instructions === 'string' &&
          node.config.instructions.length > 16_000
        )
          throw new Error('Agent 指令最多 16000 字。');
      }
      if (node.type === 'memory') {
        if (
          node.config.provider !== undefined &&
          (typeof node.config.provider !== 'string' ||
            !['window', 'job'].includes(node.config.provider))
        )
          throw new Error('程序 Memory 只支持本次任务的窗口记忆。');
        if (
          node.config.maxTurns !== undefined &&
          (!Number.isInteger(node.config.maxTurns) ||
            Number(node.config.maxTurns) < 1 ||
            Number(node.config.maxTurns) > 32)
        )
          throw new Error('Memory maxTurns 必须是 1–32。');
        issues.push({
          level: 'warning',
          nodeId: node.id,
          message: '程序 Memory 只保留本次任务内的模型对话；任务结束后清空。',
        });
      }
      if (node.type === 'output') {
        if (node.config.text !== undefined)
          validateValueTemplate(node.config.text);
        if (node.config.data !== undefined)
          validateValueTemplate(node.config.data);
        if (node.config.artifact !== undefined)
          normalizeProgramArtifact(node.config.artifact);
      }
    } catch (cause) {
      error(cause instanceof Error ? cause.message : '节点配置无效。', node.id);
    }
  }
  for (const edge of edges.filter(
    (item) => item.kind !== 'main' && item.kind !== 'branch',
  )) {
    const source = byId.get(edge.source.nodeId)!;
    const target = byId.get(edge.target.nodeId)!;
    if (
      source.type !== 'aiAgent' ||
      !(
        (edge.kind === 'model' &&
          source.ports.some(
            (port) =>
              port.id === edge.source.portId && port.id === 'resource.model',
          ) &&
          target.type === 'llmModel') ||
        (edge.kind === 'memory' &&
          edge.source.portId === 'resource.memory' &&
          target.type === 'memory')
      )
    )
      error('程序只支持 Agent 的 Model 和 Memory 资源连接。', source.id);
  }
  const executionNodeIds: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id) || !byId.has(id)) return;
    visited.add(id);
    executionNodeIds.push(id);
    const next = adjacency(id).sort((a, b) =>
      compare(b.source.portId, a.source.portId),
    );
    for (const edge of next) visit(edge.target.nodeId);
  };
  visit(snapshot.entryNodeIds[0]);
  const resourceNodeIds = nodes
    .filter(
      (node) =>
        resourceTypes.has(node.type) &&
        edges.some(
          (edge) =>
            visited.has(edge.source.nodeId) &&
            edge.target.nodeId === node.id &&
            (edge.kind === 'model' || edge.kind === 'memory'),
        ),
    )
    .map((node) => node.id);
  for (const node of nodes)
    if (!visited.has(node.id) && !resourceNodeIds.includes(node.id))
      error(`${node.name} 没有从 Trigger 可达的执行或资源连接。`, node.id);
  if (!nodes.some((node) => node.type === 'output' && visited.has(node.id)))
    error('程序至少需要一个从 Trigger 可达的 Output。');
  const base: ProgramCompileResult = {
    ok: false,
    adapter: PROGRAM_ADAPTER_ID,
    adapterVersion: PROGRAM_ADAPTER_VERSION,
    workflow: null,
    plan: null,
    bindings: [],
    compiledJson: null,
    compiledHash: null,
    graphHash,
    issues,
    requiredCredentialRefs: [],
  };
  if (issues.some((issue) => issue.level === 'error')) return base;
  const plan: ProgramPlan = {
    schemaVersion: 1,
    workflowId: options.workflowId,
    workflowVersion: options.version,
    graph: snapshot,
    inputFields,
    executionNodeIds,
    resourceNodeIds,
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

export function programCompileStats(
  graph: WorkflowGraphV1,
  result: ProgramCompileResult,
): CompileStats {
  return {
    internalNodes: graph.nodes.filter((node) => !node.disabled).length,
    externalNodes: 0,
    connections: graph.edges.length,
    unsupportedNodes: result.issues.filter(
      (issue) => issue.level === 'error' && issue.message.includes('不支持'),
    ).length,
  };
}

export function programPublishedSteps(
  graph: WorkflowGraphV1,
  plan: ProgramPlan,
): WorkflowStep[] {
  return plan.executionNodeIds.map((id) => {
    const node = graph.nodes.find((item) => item.id === id)!;
    return {
      id: `step_${id}`,
      title: node.name,
      detail: node.description,
      kind:
        node.type === 'trigger'
          ? 'input'
          : node.type === 'aiAgent'
            ? 'compose'
            : node.type === 'condition'
              ? 'decision'
              : node.type === 'output'
                ? 'output'
                : 'transform',
    };
  });
}
