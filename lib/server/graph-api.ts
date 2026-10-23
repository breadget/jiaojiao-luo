/**
 * Graph 相关路由的公共守卫。
 *
 * 单独抽出来是因为发布、版本列表、回滚、编译预览四条路由的鉴权与限流
 * 必须逐字一致 —— 少写一条限流就等于给管理面开了一个无节流的入口。
 */
import { enforceRateLimit, requireAdmin } from '@/lib/server/security';

export async function routeWorkflowId(context: {
  params: Promise<{ id: string }>;
}): Promise<string> {
  const params = await context.params;
  return params.id.trim();
}

export function guardAdminRequest(
  request: Request,
  options: { label: string; limit: number; windowMs?: number },
): Response | null {
  const rateLimitError = enforceRateLimit(request, {
    label: options.label,
    limit: options.limit,
    windowMs: options.windowMs ?? 60_000,
  });
  if (rateLimitError) return rateLimitError;
  return requireAdmin(request);
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
