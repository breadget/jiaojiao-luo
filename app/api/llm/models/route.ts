import { listAvailableModels } from '@/lib/server/llm';
import {
  enforceExecutionAccess,
  enforceRateLimit,
  readJsonObject,
} from '@/lib/server/security';

function optionalString(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

export async function POST(request: Request) {
  const accessError = enforceExecutionAccess(request, {
    allowConsumerClientMarker: true,
  });
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'llm-model-discovery',
    limit: 12,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const parsed = await readJsonObject(request, 8 * 1024);
  if ('response' in parsed) return parsed.response;
  const result = await listAvailableModels({
    apiKey: optionalString(parsed.body.apiKey, 1_000) ?? '',
    provider: optionalString(parsed.body.provider, 40),
    baseUrl: optionalString(parsed.body.baseUrl, 500),
  });
  if (!result.ok) {
    const status =
      result.code === 'LLM_NOT_CONFIGURED' ||
      result.code === 'LLM_UNSUPPORTED_PROVIDER' ||
      result.code === 'LLM_ERROR'
        ? 400
        : result.code === 'RATE_LIMITED'
          ? 429
          : result.code === 'LLM_TIMEOUT'
            ? 504
            : 502;
    return Response.json(
      { error: result.error, code: result.code },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return Response.json(result, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
