import {
  guardAdminRequest,
  jsonResponse,
  routeWorkflowId,
} from '@/lib/server/graph-api';
import { getWorkflowById } from '@/lib/server/workflow-store';
import {
  GraphPublishRejected,
  WorkflowVersionNotFound,
  rollbackWorkflowGraph,
} from '@/lib/server/workflow-version-store';

/**
 * 一键回滚：把发布指针移回指定历史版本。
 * 版本行本身不会被修改或删除，所以可以反复回滚、也可以再切回来。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; versionId: string }> },
) {
  const guard = guardAdminRequest(request, {
    label: 'workflow-graph-rollback',
    limit: 10,
  });
  if (guard) return guard;

  const params = await context.params;
  const id = await routeWorkflowId({
    params: Promise.resolve({ id: params.id }),
  });
  const versionId = params.versionId.trim();

  if (!versionId) {
    return jsonResponse({ error: '缺少要回滚到的版本。' }, 400);
  }
  if (!(await getWorkflowById(id))) {
    return jsonResponse({ error: '工作流不存在。' }, 404);
  }

  try {
    const result = await rollbackWorkflowGraph({
      workflowId: id,
      versionId,
      rolledBackBy: 'admin',
    });
    return jsonResponse({
      version: result.version,
      previousVersionId: result.previousVersionId,
      adapterLocked: result.version.adapter !== 'local-sqlite',
    });
  } catch (cause) {
    if (cause instanceof GraphPublishRejected) {
      return jsonResponse({ error: cause.message, issues: cause.issues }, 422);
    }
    if (cause instanceof WorkflowVersionNotFound) {
      return jsonResponse({ error: '该发布版本不存在。' }, 404);
    }
    throw cause;
  }
}
