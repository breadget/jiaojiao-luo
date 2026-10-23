import { deleteWorkflow } from '@/lib/server/workflow-store';
import { enforceRateLimit, requireAdmin } from '@/lib/server/security';

const WORKFLOW_ID_PATTERN = /^wf_[a-zA-Z0-9_-]{1,96}$/;

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const rateLimitError = enforceRateLimit(request, {
    label: 'workflow-delete',
    limit: 20,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const authError = requireAdmin(request);
  if (authError) return authError;

  const { id: rawId } = await context.params;
  const id = rawId.trim();
  if (!WORKFLOW_ID_PATTERN.test(id)) {
    return Response.json({ error: '工作流编号无效。' }, { status: 400 });
  }

  const result = await deleteWorkflow(id);
  if (result === 'not_found') {
    return Response.json({ error: '工作流不存在或已删除。' }, { status: 404 });
  }
  if (result === 'last_workflow') {
    return Response.json(
      { error: '至少保留一个工作流；请先新建工作流再删除这个。' },
      { status: 409 },
    );
  }

  return Response.json(
    { deleted: true, workflowId: id },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
