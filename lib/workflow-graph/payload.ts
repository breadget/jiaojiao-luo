import type {
  ConnectionKind,
  WorkflowGraphV1,
} from '@/lib/workflow-graph/types';
import { studioNodeTypes } from '@/lib/workflow-graph/types';
import { validateAgentConstraints } from '@/lib/workflow-graph/agent-constraints';
import {
  isLocalDatabaseNode,
  validateLocalDatabaseConfig,
} from '@/lib/workflow-graph/local-database';
import type { WorkflowGraphNode } from '@/lib/workflow-graph/types';

/** Graph 草稿的请求体上限；100 个节点的正常草稿远小于它。 */
export const GRAPH_JSON_LIMIT_BYTES = 512 * 1024;

/** 与 API 的 100 节点 / 300 连接的规模上限保持一致。 */
export const GRAPH_MAX_NODES = 100;
export const GRAPH_MAX_EDGES = 300;

const connectionKinds: readonly ConnectionKind[] = [
  'main',
  'model',
  'memory',
  'tool',
  'branch',
  'subworkflow',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPort(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.label === 'string' &&
    connectionKinds.includes(value.kind as ConnectionKind) &&
    (value.direction === 'input' || value.direction === 'output') &&
    typeof value.required === 'boolean' &&
    (value.maxConnections === null ||
      (typeof value.maxConnections === 'number' &&
        Number.isInteger(value.maxConnections) &&
        value.maxConnections >= 0))
  );
}

function isNode(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const position = value.position;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    studioNodeTypes.includes(value.type as (typeof studioNodeTypes)[number]) &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    isPlainObject(position) &&
    typeof position.x === 'number' &&
    typeof position.y === 'number' &&
    Array.isArray(value.ports) &&
    value.ports.every(isPort) &&
    isPlainObject(value.config) &&
    (value.type !== 'aiAgent' ||
      validateAgentConstraints(value.config.constraints) === null) &&
    (!isLocalDatabaseNode(value as unknown as WorkflowGraphNode) ||
      validateLocalDatabaseConfig(value.config, { allowIncomplete: true }) ===
        null)
  );
}

function isEndpoint(
  value: unknown,
): value is { nodeId: string; portId: string } {
  return (
    isPlainObject(value) &&
    typeof value.nodeId === 'string' &&
    value.nodeId.length > 0 &&
    typeof value.portId === 'string' &&
    value.portId.length > 0
  );
}

function isEdge(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    connectionKinds.includes(value.kind as ConnectionKind) &&
    isEndpoint(value.source) &&
    isEndpoint(value.target)
  );
}

/**
 * Graph 请求体的形状守卫。
 *
 * 严的地方：节点、端口、连接都是结构化的，任何一个畸形元素都会让
 * validator / projector / adapter 在运行期炸掉，所以必须在入口挡住。
 * 松的地方：viewport / metadata 只是展示信息，缺了不影响任何语义，
 * 不因为装饰字段把一份本来能用的草稿判成 400。
 */
export function isWorkflowGraphPayload(
  value: unknown,
): value is WorkflowGraphV1 {
  if (!isPlainObject(value)) return false;
  const graph = value as unknown as Partial<WorkflowGraphV1>;
  const runtime = graph.runtime;

  return (
    graph.schemaVersion === 1 &&
    typeof graph.id === 'string' &&
    graph.id.length > 0 &&
    typeof graph.name === 'string' &&
    typeof graph.description === 'string' &&
    Number.isInteger(graph.revision) &&
    (graph.revision ?? -1) >= 0 &&
    Array.isArray(graph.nodes) &&
    graph.nodes.length >= 1 &&
    graph.nodes.length <= GRAPH_MAX_NODES &&
    graph.nodes.every(isNode) &&
    new Set((graph.nodes as { id: string }[]).map((node) => node.id)).size ===
      graph.nodes.length &&
    Array.isArray(graph.edges) &&
    graph.edges.length <= GRAPH_MAX_EDGES &&
    graph.edges.every(isEdge) &&
    new Set((graph.edges as { id: string }[]).map((edge) => edge.id)).size ===
      graph.edges.length &&
    Array.isArray(graph.entryNodeIds) &&
    graph.entryNodeIds.every((id) => typeof id === 'string') &&
    isPlainObject(runtime) &&
    (runtime.engine === 'n8n' || runtime.engine === 'local-sqlite') &&
    typeof runtime.adapter === 'string' &&
    typeof runtime.executionMode === 'string' &&
    (runtime.binding === 'external' || runtime.binding === 'draft')
  );
}

/**
 * 凭据类字段一律拒绝：Graph 只能保存"引用"，不能保存密钥本体。
 *
 * 判定分两层：
 *  1) 键名 —— 先归一化（去掉 - 和 _），再按"包含"匹配核心词，
 *     这样 X-Api-Key / api_key / apiKey 都拦得住；
 *     但 `credentialRef` / `credentialId` 这类**引用形态**必须放行，
 *     否则连正常的"引用 n8n 凭证"都存不进来。
 *  2) 值形态 —— 只匹配高置信度的凭据格式，见 FORBIDDEN_VALUE_PATTERNS。
 */
const SECRET_KEY_MARKERS = [
  'apikey',
  'authorization',
  'bearer',
  'clientsecret',
  'cookie',
  'credential',
  'passwd',
  'password',
  'privatekey',
  'secret',
  'sessiontoken',
  'signingkey',
  'token',
];

/** 以这些后缀结尾的键是"引用"而不是"密钥"。 */
const REFERENCE_SUFFIXES = [
  'ref',
  'id',
  'name',
  'env',
  'path',
  'url',
  'policy',
];

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll('-', '').replaceAll('_', '');
  if (REFERENCE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    // `token` 本身不算引用；`tokenRef` 才算。
    if (!SECRET_KEY_MARKERS.includes(normalized)) return false;
  }
  return SECRET_KEY_MARKERS.some((marker) => normalized.includes(marker));
}

/** 供事件脱敏复用：这个键名是不是凭据类。 */
export function isSecretKeyName(key: string): boolean {
  return isSecretKey(key);
}

/**
 * 只匹配高置信度的凭据**值**形态。
 *
 * 这里刻意不用"长随机串 / 纯 hex"这类通用启发式：本项目自己就会产生
 * 64 位十六进制的合法内容哈希（`graph_hash`、`compiled_hash`、边 id 也可能很长），
 * 通用规则会把正常草稿判成"带密钥"而拒绝保存，甚至让编译产物自检通不过。
 * 所以只留无歧义的前缀与结构；字段名那一层负责剩下的情况。
 */
const FORBIDDEN_VALUE_PATTERNS = [
  /\bbearer\s+[A-Za-z0-9._~+/-]{12,}=*/i,
  /\bbasic\s+[A-Za-z0-9+/]{12,}={0,2}/i,
  /\bsk-[A-Za-z0-9-]{16,}\b/,
  /\bghp_[A-Za-z0-9]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function looksLikeSecretValue(value: string): boolean {
  return FORBIDDEN_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

export function findCredentialMaterial(
  value: unknown,
  path = '$',
  seen = new Set<object>(),
): string | null {
  if (typeof value === 'string') {
    return looksLikeSecretValue(value) ? path : null;
  }
  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findCredentialMaterial(item, `${path}[${index}]`, seen);
      if (found) return found;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (isSecretKey(key)) {
      return childPath;
    }
    const found = findCredentialMaterial(child, childPath, seen);
    if (found) return found;
  }
  return null;
}

/** 兼容旧调用点的布尔封装。 */
export function containsCredentialMaterial(value: unknown): boolean {
  return findCredentialMaterial(value) !== null;
}
