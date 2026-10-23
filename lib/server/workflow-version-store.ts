/**
 * 不可变发布版本（workflow_versions）。
 *
 * 设计边界：
 *  - **草稿 revision 与发布 version 是两套编号**。草稿可以一直改（revision 递增），
 *    发布产生一条只读快照（version 递增）；两者不复用同一个计数器，
 *    所以"改草稿"永远不会影响已发布的版本。
 *  - `workflow_versions` 只增不改。回滚不是覆盖，而是把
 *    `workflows.active_graph_version_id` 指回旧版本。
 *  - 发布是**全有或全无**：编译失败不写任何东西；写库用 D1 batch（隐式事务），
 *    失败时再兜底清理一次，绝不留"有版本行、没有绑定"这种半成品。
 */
import { getD1 } from '@/db';
import {
  ADAPTER_ID,
  ADAPTER_VERSION,
  compileGraphToN8n,
  compileStats,
} from '@/lib/workflow-graph/adapter/n8n-v1';
import type {
  AdapterIssue,
  CompiledNodeBinding,
} from '@/lib/workflow-graph/adapter/types';
import type { WorkflowGraphV1 } from '@/lib/workflow-graph/types';
import {
  GraphRevisionConflict,
  getWorkflowGraphDraft,
} from '@/lib/server/workflow-graph-store';

export class GraphPublishRejected extends Error {
  constructor(public readonly issues: AdapterIssue[]) {
    super('Graph 未通过编译，发布已取消。');
    this.name = 'GraphPublishRejected';
  }
}

export class WorkflowVersionNotFound extends Error {
  constructor(public readonly versionId: string) {
    super(`发布版本 ${versionId} 不存在。`);
    this.name = 'WorkflowVersionNotFound';
  }
}

export type WorkflowVersionRow = {
  id: string;
  workflow_id: string;
  version: number;
  schema_version: number;
  graph_revision: number;
  graph_hash: string;
  adapter: string;
  adapter_version: string;
  compiled_hash: string | null;
  external_workflow_id: string | null;
  webhook_path: string | null;
  node_count: number;
  connection_count: number;
  published_at: number;
  published_by: string | null;
};

export type WorkflowVersionSummary = {
  id: string;
  workflowId: string;
  version: number;
  schemaVersion: number;
  graphRevision: number;
  graphHash: string;
  compiledHash: string | null;
  adapter: string;
  adapterVersion: string;
  externalWorkflowId: string | null;
  webhookPath: string | null;
  nodeCount: number;
  connectionCount: number;
  publishedAt: number;
  publishedBy: string | null;
  active: boolean;
};

export type PublishedVersion = WorkflowVersionSummary & {
  graph: WorkflowGraphV1;
  bindings: CompiledNodeBinding[];
  issues: AdapterIssue[];
  requiredCredentialRefs: string[];
};

const SUMMARY_COLUMNS = `id, workflow_id, version, schema_version, graph_revision,
  graph_hash, adapter, adapter_version, compiled_hash, external_workflow_id,
  webhook_path, node_count, connection_count, published_at, published_by`;

function toSummary(row: WorkflowVersionRow, activeId: string | null): WorkflowVersionSummary {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    version: row.version,
    schemaVersion: row.schema_version,
    graphRevision: row.graph_revision,
    graphHash: row.graph_hash,
    compiledHash: row.compiled_hash,
    adapter: row.adapter,
    adapterVersion: row.adapter_version,
    externalWorkflowId: row.external_workflow_id,
    webhookPath: row.webhook_path,
    nodeCount: row.node_count,
    connectionCount: row.connection_count,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    active: activeId !== null && activeId === row.id,
  };
}

export async function getActiveGraphVersionId(
  workflowId: string,
): Promise<string | null> {
  const row = await getD1()
    .prepare(
      `SELECT active_graph_version_id FROM workflows WHERE id = ? LIMIT 1`,
    )
    .bind(workflowId)
    .first<{ active_graph_version_id: string | null }>();
  return row?.active_graph_version_id ?? null;
}

export async function listWorkflowVersions(
  workflowId: string,
): Promise<WorkflowVersionSummary[]> {
  const activeId = await getActiveGraphVersionId(workflowId);
  const result = await getD1()
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM workflow_versions
       WHERE workflow_id = ?
       ORDER BY version DESC`,
    )
    .bind(workflowId)
    .all<WorkflowVersionRow>();
  return (result.results ?? []).map((row) => toSummary(row, activeId));
}

export async function listNodeBindings(
  versionId: string,
): Promise<CompiledNodeBinding[]> {
  const result = await getD1()
    .prepare(
      `SELECT internal_node_id, external_node_id, external_node_name, role
       FROM workflow_node_bindings
       WHERE workflow_version_id = ?
       ORDER BY internal_node_id, role`,
    )
    .bind(versionId)
    .all<{
      internal_node_id: string;
      external_node_id: string;
      external_node_name: string | null;
      role: string;
    }>();
  return (result.results ?? []).map((row) => ({
    internalNodeId: row.internal_node_id,
    externalNodeId: row.external_node_id,
    externalNodeName: row.external_node_name ?? row.external_node_id,
    role: row.role,
  }));
}

export async function getWorkflowVersion(
  versionId: string,
): Promise<PublishedVersion | null> {
  const row = await getD1()
    .prepare(
      `SELECT ${SUMMARY_COLUMNS}, graph_json FROM workflow_versions
       WHERE id = ? LIMIT 1`,
    )
    .bind(versionId)
    .first<WorkflowVersionRow & { graph_json: string }>();
  if (!row) return null;
  const activeId = await getActiveGraphVersionId(row.workflow_id);
  return {
    ...toSummary(row, activeId),
    graph: JSON.parse(row.graph_json) as WorkflowGraphV1,
    bindings: await listNodeBindings(versionId),
    // 历史版本只回放"当时记录了什么"，不再重新编译一次。
    issues: [],
    requiredCredentialRefs: [],
  };
}

/** 发布指针指向的完整版本（含绑定），供运行时把 n8n 节点还原成内部 nodeId。 */
export async function getActiveWorkflowVersion(
  workflowId: string,
): Promise<PublishedVersion | null> {
  const activeId = await getActiveGraphVersionId(workflowId);
  if (!activeId) return null;
  return getWorkflowVersion(activeId);
}

async function nextVersionNumber(workflowId: string): Promise<number> {
  const row = await getD1()
    .prepare(
      `SELECT MAX(version) AS max_version FROM workflow_versions WHERE workflow_id = ?`,
    )
    .bind(workflowId)
    .first<{ max_version: number | null }>();
  return (row?.max_version ?? 0) + 1;
}

export type PublishInput = {
  workflowId: string;
  /** 必须与草稿当前 revision 一致，避免发布一份已经过期的画布。 */
  expectedRevision: number;
  /** 可选：客户端本地草稿的哈希；不一致说明本地有未保存修改。 */
  expectedGraphHash?: string;
  publishedBy?: string | null;
  webhookPath?: string;
};

/**
 * 把**库里已保存的草稿**编译并固化成一条不可变发布版本。
 *
 * 注意读的是数据库里的草稿，不是请求体里带来的图：发布的对象必须是
 * "服务端认可的那一份"，否则客户端可以绕过草稿校验直接发布任意内容。
 */
export async function publishWorkflowGraph(
  input: PublishInput,
): Promise<{ version: PublishedVersion; issues: AdapterIssue[] }> {
  const draft = await getWorkflowGraphDraft(input.workflowId);
  if (!draft) {
    throw new GraphPublishRejected([
      { level: 'error', message: '还没有保存过 Graph 草稿，无法发布。' },
    ]);
  }
  if (draft.graph.revision !== input.expectedRevision) {
    throw new GraphRevisionConflict(draft.graph.revision);
  }
  if (input.expectedGraphHash && input.expectedGraphHash !== draft.hash) {
    throw new GraphRevisionConflict(draft.graph.revision);
  }

  const version = await nextVersionNumber(input.workflowId);
  const compiled = await compileGraphToN8n(draft.graph, {
    workflowId: input.workflowId,
    version,
    webhookPath: input.webhookPath,
  });

  if (!compiled.ok || !compiled.workflow || !compiled.compiledJson) {
    // 编译失败：一个字都不写。这是"发布失败不得留下半成品"的第一道保证。
    throw new GraphPublishRejected(compiled.issues);
  }

  const stats = compileStats(draft.graph, compiled);
  const versionId = `wfv_${crypto.randomUUID()}`;
  const publishedAt = Date.now();

  const statements = [
    getD1()
      .prepare(
        `INSERT INTO workflow_versions (
           id, workflow_id, version, schema_version, graph_revision, graph_json,
           graph_hash, adapter, adapter_version, compiled_json, compiled_hash,
           webhook_path, node_count, connection_count, published_at, published_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        versionId,
        input.workflowId,
        version,
        draft.graph.schemaVersion,
        draft.graph.revision,
        JSON.stringify(draft.graph),
        compiled.graphHash,
        ADAPTER_ID,
        ADAPTER_VERSION,
        compiled.compiledJson,
        compiled.compiledHash,
        input.webhookPath ?? null,
        stats.internalNodes,
        stats.connections,
        publishedAt,
        input.publishedBy ?? null,
      ),
    ...compiled.bindings.map((binding) =>
      getD1()
        .prepare(
          `INSERT INTO workflow_node_bindings (
             workflow_version_id, internal_node_id, external_node_id,
             external_node_name, role
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          versionId,
          binding.internalNodeId,
          binding.externalNodeId,
          binding.externalNodeName,
          binding.role,
        ),
    ),
    getD1()
      .prepare(
        `UPDATE workflows
         SET active_graph_version_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(versionId, publishedAt, input.workflowId),
  ];

  try {
    await getD1().batch(statements);
  } catch (cause) {
    // 兜底：即使 batch 在某些 D1 兼容实现里不是原子的，也不留下孤儿版本行
    // （绑定表有 ON DELETE CASCADE，会跟着一起清掉）。
    try {
      await getD1()
        .prepare(`DELETE FROM workflow_versions WHERE id = ?`)
        .bind(versionId)
        .run();
    } catch {
      // 清理失败不应掩盖原始错误
    }
    throw cause;
  }

  const published = await getWorkflowVersion(versionId);
  if (!published) {
    throw new WorkflowVersionNotFound(versionId);
  }
  return { version: published, issues: compiled.issues };
}

export type RollbackInput = {
  workflowId: string;
  versionId: string;
  rolledBackBy?: string | null;
};

/**
 * 一键回滚：把发布指针移回指定历史版本。
 * 不删除、不修改任何版本行，所以可以反复来回切。
 */
export async function rollbackWorkflowGraph(
  input: RollbackInput,
): Promise<{ version: PublishedVersion; previousVersionId: string | null }> {
  const target = await getD1()
    .prepare(
      `SELECT id FROM workflow_versions WHERE id = ? AND workflow_id = ? LIMIT 1`,
    )
    .bind(input.versionId, input.workflowId)
    .first<{ id: string }>();
  if (!target) throw new WorkflowVersionNotFound(input.versionId);

  const previousVersionId = await getActiveGraphVersionId(input.workflowId);
  await getD1()
    .prepare(
      `UPDATE workflows
       SET active_graph_version_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(input.versionId, Date.now(), input.workflowId)
    .run();

  const version = await getWorkflowVersion(input.versionId);
  if (!version) throw new WorkflowVersionNotFound(input.versionId);
  return { version, previousVersionId };
}

/**
 * 只编译、不写库：Studio 的"编译预览"。
 * 用下一个版本号，所以预览的 hash 与真正发布后的 compiled_hash 完全一致。
 */
export async function previewWorkflowGraph(input: {
  workflowId: string;
  graph: WorkflowGraphV1;
  webhookPath?: string;
}) {
  const version = await nextVersionNumber(input.workflowId);
  const compiled = await compileGraphToN8n(input.graph, {
    workflowId: input.workflowId,
    version,
    webhookPath: input.webhookPath,
  });
  return {
    nextVersion: version,
    ...compiled,
    stats: compileStats(input.graph, compiled),
  };
}
