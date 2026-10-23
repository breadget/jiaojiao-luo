import {
  getRecentRuns,
  listWorkflows,
  toPublicRun,
  toPublicWorkflow,
} from '@/lib/server/workflow-store';
import { isTrustedLocalRequest } from '@/lib/server/security';

export async function GET(request: Request) {
  const requestedPage = Number.parseInt(
    new URL(request.url).searchParams.get('runPage') ?? '0',
    10,
  );
  const runPage = Number.isFinite(requestedPage)
    ? Math.min(Math.max(requestedPage, 0), 1_250)
    : 0;
  const pageSize = 8;
  const workflows = await listWorkflows();
  const runWindow = await getRecentRuns(undefined, {
    limit: pageSize + 1,
    offset: runPage * pageSize,
  });
  const runs = runWindow.slice(0, pageSize);

  return Response.json(
    {
      workflows: workflows.map(toPublicWorkflow),
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
