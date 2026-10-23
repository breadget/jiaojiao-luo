import {
  askCourseQuestion,
  CourseAssistantClientError,
  courseAssistantErrorResponse,
  requireCourseRequest,
} from '@/lib/server/course-assistant-client';
import { enforceRateLimit, readJsonObject } from '@/lib/server/security';

export async function POST(request: Request) {
  const denied = requireCourseRequest(request);
  if (denied) return denied;
  // Direct ECS Nginx overwrites X-Real-IP. Never use a visitor-supplied
  // CF-Connecting-IP header to select this public endpoint's rate bucket.
  const rateRequest = new Request(request.url, {
    headers: { 'X-Real-IP': request.headers.get('X-Real-IP')?.trim() || 'anonymous' },
  });
  const rateLimit = enforceRateLimit(rateRequest, {
    label: 'course-question',
    limit: 12,
    windowMs: 60_000,
  });
  if (rateLimit) {
    return Response.json(
      {
        error: { code: 'rate_limited', message: '请求过于频繁，请稍后重试。' },
      },
      { status: rateLimit.status, headers: rateLimit.headers },
    );
  }
  if (
    request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  ) {
    return courseAssistantErrorResponse(
      new CourseAssistantClientError(
        '请求内容必须为 JSON。',
        'unsupported_media_type',
        415,
      ),
    );
  }
  const parsed = await readJsonObject(request, 16 * 1024);
  if ('response' in parsed) {
    const oversized = parsed.response.status === 413;
    return courseAssistantErrorResponse(
      new CourseAssistantClientError(
        oversized
          ? '请求内容不能超过 16 KB。'
          : '请求内容必须是有效的 JSON 对象。',
        oversized ? 'request_too_large' : 'invalid_request',
        parsed.response.status,
      ),
    );
  }
  const question =
    typeof parsed.body.question === 'string' ? parsed.body.question.trim() : '';
  if (!question || question.length > 2000) {
    return courseAssistantErrorResponse(
      new CourseAssistantClientError(
        '请输入 1 至 2000 字的课程问题。',
        'invalid_question',
        400,
      ),
    );
  }
  try {
    return Response.json(await askCourseQuestion(question), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (cause) {
    return courseAssistantErrorResponse(cause);
  }
}
