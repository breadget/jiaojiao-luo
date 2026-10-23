import { createWorkflow } from '@/lib/server/workflow-store';
import { saveWorkflowGraphDraft } from '@/lib/server/workflow-graph-store';
import { createCourseProgramGraph } from '@/lib/workflow-program/templates';
import {
  enforceRateLimit,
  enforceRequestPolicy,
  readJsonObject,
  requireAdmin,
} from '@/lib/server/security';

export async function POST(request: Request) {
  const denied =
    enforceRequestPolicy(request) ??
    requireAdmin(request) ??
    enforceRateLimit(request, {
      label: 'program-template',
      limit: 15,
      windowMs: 60_000,
    });
  if (denied) return denied;
  const parsed = await readJsonObject(request, 1024);
  if ('response' in parsed) return parsed.response;
  if (
    !['course-learning', 'course-retrieval'].includes(String(parsed.body.kind))
  )
    return Response.json({ error: '请选择有效的程序模板。' }, { status: 400 });
  const workflow = await createWorkflow();
  const graph = createCourseProgramGraph(workflow.id, {
    withModel: parsed.body.kind === 'course-learning',
  });
  const saved = await saveWorkflowGraphDraft({
    workflowId: workflow.id,
    graph,
    expectedRevision: 0,
    updatedBy: 'admin',
  });
  return Response.json(
    {
      workflow: {
        ...workflow,
        name: graph.name,
        description: graph.description,
      },
      graph: saved.graph,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
