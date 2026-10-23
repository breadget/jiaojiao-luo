import { env } from 'cloudflare:workers';
import {
  enforceRequestPolicy,
  isTrustedLocalRequest,
} from '@/lib/server/security';

const ENABLED_VALUES = new Set(['1', 'true', 'on', 'yes']);

export function isLocalControlEnabled(): boolean {
  const value = env.LOCAL_CONTROL_ENABLED?.trim().toLowerCase() ?? '';
  return ENABLED_VALUES.has(value);
}

/**
 * Full shell access is intentionally unavailable through public hostnames,
 * proxies, and cross-origin browser requests—even when env vars are present.
 */
export function requireLocalControlRequest(request: Request): Response | null {
  const policy = enforceRequestPolicy(request);
  if (policy) return policy;
  if (!isTrustedLocalRequest(request)) {
    return Response.json(
      { error: '页面不存在。', code: 'NOT_FOUND' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (!isLocalControlEnabled()) {
    return Response.json(
      {
        error: '本机控制尚未启动。请用 npm run dev:control 打开本机全权限模式。',
        code: 'LOCAL_CONTROL_DISABLED',
        local: true,
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return null;
}
