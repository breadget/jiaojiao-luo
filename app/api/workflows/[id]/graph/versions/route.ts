import { guardAdminRequest, jsonResponse, routeWorkflowId } from '@/lib/server/graph-api';
import { getWorkflowById } from '@/lib/server/workflow-store';
import {
  getActiveGraphVersionId,
  listWorkflowVersions,
} from '@/lib/server/workflow-version-store';

/** 发布版本列表（含当前生效版本），供 Studio 显示历史与一键回滚目标。 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const guard = guardAdminRequest(request, {
    label: 'workflow-graph-versions',
    limit: 60,
  });
  if (guard) return guard;

  const id = await routeWorkflowId(context);
  if (!(await getWorkflowById(id))) {
    return jsonResponse({ error: '工作流不存在。' }, 404);
  }

  const [versions, activeVersionId] = await Promise.all([
    listWorkflowVersions(id),
    getActiveGraphVersionId(id),
  ]);
  return jsonResponse({ versions, activeVersionId });
}
