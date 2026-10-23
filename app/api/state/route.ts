import { env } from 'cloudflare:workers';
import { getD1 } from '@/db';

import {
  getRecentRuns,
  listWorkflows,
  toPublicRun,
  toPublicWorkflow,
} from '@/lib/server/workflow-store';
import { enforceRateLimit, isTrustedLocalRequest } from '@/lib/server/security';

export async function GET(request: Request) {
  const rateLimitError = enforceRateLimit(request, {
    label: 'public-state-read',
    limit: 120,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const requestedPage = Number.parseInt(
    new URL(request.url).searchParams.get('runPage') ?? '0',
    10,
  );
  const runPage = Number.isFinite(requestedPage)
    ? Math.min(Math.max(requestedPage, 0), 1_250)
    : 0;
  const pageSize = 8;
  const workflows = await listWorkflows();
  // Only expose a capability flag from the current immutable published version.
  // Never read or serialize a graph, computer path, or local connection credential.
  const databaseVersions = await getD1()
    .prepare(
      `SELECT w.id FROM workflows w
     INNER JOIN workflow_versions v
       ON v.id = w.active_graph_version_id AND v.workflow_id = w.id
     WHERE v.adapter = ?`,
    )
    .bind('local-sqlite')
    .all<{ id: string }>();
  const localDatabaseWorkflowIds = new Set(
    databaseVersions.results.map((row) => row.id),
  );
  const programVersions = await getD1()
    .prepare(
      `SELECT w.id FROM workflows w INNER JOIN workflow_versions v ON v.id = w.active_graph_version_id AND v.workflow_id = w.id WHERE v.adapter = ? AND w.deleted_at IS NULL`,
    )
    .bind('program-v1')
    .all<{ id: string }>();
  const programWorkflowIds = new Set(
    programVersions.results.map((row) => row.id),
  );
  const runWindow = await getRecentRuns(undefined, {
    limit: pageSize + 1,
    offset: runPage * pageSize,
  });
  const runs = runWindow.slice(0, pageSize);

  return Response.json(
    {
      releaseSha: env.URTORIS_RELEASE_SHA ?? null,
      workflows: workflows.map((workflow) =>
        toPublicWorkflow(
          programWorkflowIds.has(workflow.id)
            ? { ...workflow, programRuntime: 'program-v1' }
            : localDatabaseWorkflowIds.has(workflow.id)
              ? { ...workflow, databaseRuntime: 'local-sqlite' }
              : workflow,
        ),
      ),
      runs: runs.map(toPublicRun),
      runPagination: {
        page: runPage,
        hasPrevious: runPage > 0,
        hasNext: runWindow.length > pageSize,
      },
      /**
       * 本机 / 内网访问会被当成管理员会话（免令牌）。
       * 这只是告诉当前这位访问者"你的请求被信任"，不泄露任何服务端配置。
       */
      adminTrusted: isTrustedLocalRequest(request),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
