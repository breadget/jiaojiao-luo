import {
  courseAssistantErrorResponse,
  fetchCourseStatus,
  requireCourseRequest,
} from '@/lib/server/course-assistant-client';

export async function GET(request: Request) {
  const denied = requireCourseRequest(request);
  if (denied) return denied;
  try {
    return Response.json(await fetchCourseStatus(), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (cause) {
    return courseAssistantErrorResponse(cause);
  }
}
