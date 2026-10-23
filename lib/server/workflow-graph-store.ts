import { getD1 } from '@/db';
import { hashGraphContent } from '@/lib/workflow-graph/hash';
import type { WorkflowGraphV1 } from '@/lib/workflow-graph/types';

type GraphDraftRow = {
  workflow_id: string;
  schema_version: number;
  revision: number;
  graph_json: string;
  graph_hash: string;
  updated_at: number;
  updated_by: string | null;
};

export class GraphRevisionConflict extends Error {
  constructor(public readonly currentRevision: number) {
    super(`Graph revision conflict; current revision is ${currentRevision}.`);
    this.name = 'GraphRevisionConflict';
  }
}

export async function getWorkflowGraphDraft(workflowId: string) {
  const row = await getD1()
    .prepare(
      `SELECT workflow_id, schema_version, revision, graph_json, graph_hash,
        updated_at, updated_by
       FROM workflow_graph_drafts
       WHERE workflow_id = ?
       LIMIT 1`,
    )
    .bind(workflowId)
    .first<GraphDraftRow>();

  if (!row) return null;
  return {
    graph: JSON.parse(row.graph_json) as WorkflowGraphV1,
    hash: row.graph_hash,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export async function saveWorkflowGraphDraft(input: {
  workflowId: string;
  graph: WorkflowGraphV1;
  expectedRevision: number;
  updatedBy?: string | null;
}) {
  const existing = await getD1()
    .prepare(
      `SELECT revision FROM workflow_graph_drafts WHERE workflow_id = ? LIMIT 1`,
    )
    .bind(input.workflowId)
    .first<{ revision: number }>();
  const currentRevision = existing?.revision ?? 0;
  if (currentRevision !== input.expectedRevision) {
    throw new GraphRevisionConflict(currentRevision);
  }

  const now = Date.now();
  const nextGraph: WorkflowGraphV1 = {
    ...input.graph,
    id: input.workflowId,
    revision: currentRevision + 1,
    metadata: { ...input.graph.metadata, updatedAt: now },
  };
  const serialized = JSON.stringify(nextGraph);
  const hash = await hashGraphContent(nextGraph);

  if (existing) {
    const result = await getD1()
      .prepare(
        `UPDATE workflow_graph_drafts
         SET schema_version = ?, revision = ?, graph_json = ?, graph_hash = ?,
             updated_at = ?, updated_by = ?
         WHERE workflow_id = ? AND revision = ?`,
      )
      .bind(
        nextGraph.schemaVersion,
        nextGraph.revision,
        serialized,
        hash,
        now,
        input.updatedBy ?? null,
        input.workflowId,
        currentRevision,
      )
      .run();
    if (!result.success || result.meta.changes !== 1) {
      const latest = await getD1()
        .prepare(
          `SELECT revision FROM workflow_graph_drafts WHERE workflow_id = ? LIMIT 1`,
        )
        .bind(input.workflowId)
        .first<{ revision: number }>();
      throw new GraphRevisionConflict(latest?.revision ?? currentRevision);
    }
  } else {
    try {
      await getD1()
        .prepare(
          `INSERT INTO workflow_graph_drafts (
             workflow_id, schema_version, revision, graph_json, graph_hash,
             updated_at, updated_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.workflowId,
          nextGraph.schemaVersion,
          nextGraph.revision,
          serialized,
          hash,
          now,
          input.updatedBy ?? null,
        )
        .run();
    } catch {
      const latest = await getD1()
        .prepare(
          `SELECT revision FROM workflow_graph_drafts WHERE workflow_id = ? LIMIT 1`,
        )
        .bind(input.workflowId)
        .first<{ revision: number }>();
      throw new GraphRevisionConflict(latest?.revision ?? 0);
    }
  }

  return { graph: nextGraph, hash, updatedAt: now };
}
