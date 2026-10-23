import {
  getRecentRuns,
  listWorkflows,
  toPublicRun,
  toPublicWorkflow,
} from '@/lib/server/workflow-store';
import { isTrustedLocalRequest } from '@/lib/server/security';

export async function GET(request: Request) {
  const workflows = await listWorkflows();
  const runs = await getRecentRuns();

  return Response.json(
    {
      workflows: workflows.map(toPublicWorkflow),
      runs: runs.map(toPublicRun),
      /**
       * 本机 / 内网访问会被当成管理员会话（免令牌）。
       * 这只是告诉当前这位访问者"你的请求被信任"，不泄露任何服务端配置。
       */
      adminTrusted: isTrustedLocalRequest(request),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
