import type { CourseSource } from '../../lib/course-assistant-types';
import { ProgramServiceError, record } from './safety';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const TOKEN = /^(?:[A-Za-z0-9]{32}|[A-Za-z0-9]{64})$/;

export function courseOrigin(configured = 'http://127.0.0.1:8001'): string {
  try {
    const url = new URL(configured);
    if (
      url.protocol !== 'http:' ||
      !LOOPBACK.has(url.hostname) ||
      url.pathname !== '/' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error('COURSE_ASSISTANT_URL must be a loopback HTTP origin.');
  }
}

function invalid(): ProgramServiceError {
  return new ProgramServiceError(
    'COURSE_INVALID_RESPONSE',
    '课程服务返回了无效内容。',
    502,
  );
}

async function readText(response: Response): Promise<string> {
  const maximum = 512 * 1024;
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel();
    throw invalid();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let value = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw invalid();
      }
      value += decoder.decode(part.value, { stream: true });
    }
    return value + decoder.decode();
  } catch (cause) {
    if (
      cause instanceof ProgramServiceError ||
      (cause instanceof Error && cause.name === 'AbortError')
    )
      throw cause;
    throw invalid();
  } finally {
    reader.releaseLock();
  }
}

async function fetchLocal(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    redirect: 'manual',
    cache: 'no-store',
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw invalid();
  }
  return response;
}

function csrf(home: Response, html: string): { cookie: string; token: string } {
  let token = '';
  for (const input of html.matchAll(/<input\b[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const attr of input[0].matchAll(
      /([A-Za-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
    ))
      attrs.set(attr[1].toLowerCase(), attr[2] ?? attr[3] ?? attr[4]);
    if (
      attrs.get('name') === 'csrfmiddlewaretoken' &&
      attrs.get('type')?.toLowerCase() === 'hidden' &&
      TOKEN.test(attrs.get('value') ?? '')
    ) {
      token = attrs.get('value')!;
      break;
    }
  }
  const cookies = home.headers.getSetCookie?.() ?? [
    home.headers.get('set-cookie') ?? '',
  ];
  let secret = '';
  for (const cookie of cookies) {
    const value =
      cookie.match(/(?:^|,\s*)csrftoken=([A-Za-z0-9]+)(?=;|,|$)/)?.[1] ?? '';
    if (TOKEN.test(value)) {
      secret = value;
      break;
    }
  }
  if (!token || !secret) throw invalid();
  return { cookie: `csrftoken=${secret}`, token };
}

function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    !!value.trim() &&
    value.length <= maximum &&
    !Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 &&
        ![9, 10, 13].includes(character.charCodeAt(0)),
    )
  );
}

function source(value: unknown): CourseSource {
  if (
    !record(value) ||
    !text(value.id, 128) ||
    !text(value.filename, 300) ||
    /[\\/\r\n\t]/.test(value.filename) ||
    !Number.isSafeInteger(value.page) ||
    Number(value.page) < 1 ||
    Number(value.page) > 100_000_000 ||
    !text(value.excerpt, 16_000) ||
    typeof value.score !== 'number' ||
    !Number.isFinite(value.score)
  )
    throw invalid();
  return {
    id: value.id,
    filename: value.filename,
    page: Number(value.page),
    excerpt: value.excerpt,
    score: value.score,
  };
}

/** Independent CSRF session; no model key or caller Authorization is forwarded. */
export function createCourseRetriever(configured?: string, timeoutMs = 8000) {
  const origin = courseOrigin(configured);
  return async (
    question: string,
    signal: AbortSignal,
  ): Promise<CourseSource[]> => {
    if (!text(question, 2000) || question !== question.trim())
      throw new ProgramServiceError(
        'INVALID_QUESTION',
        '请输入 1 至 2000 字的课程问题。',
      );
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      controller.abort();
    }, timeoutMs);
    try {
      const home = await fetchLocal(`${origin}/`, {
        headers: { Accept: 'text/html' },
        signal: controller.signal,
      });
      if (!home.ok) {
        await home.body?.cancel();
        throw invalid();
      }
      const session = csrf(home, await readText(home));
      const response = await fetchLocal(`${origin}/api/retrieve/`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Cookie: session.cookie,
          'X-CSRFToken': session.token,
          Origin: origin,
          Referer: `${origin}/`,
        },
        body: JSON.stringify({ question }),
      });
      if (
        response.headers
          .get('content-type')
          ?.split(';')[0]
          .trim()
          .toLowerCase() !== 'application/json'
      ) {
        await response.body?.cancel();
        throw invalid();
      }
      let value: unknown;
      try {
        value = JSON.parse(await readText(response));
      } catch (cause) {
        if (controller.signal.aborted) throw cause;
        throw invalid();
      }
      if (!response.ok)
        throw new ProgramServiceError(
          'COURSE_UNAVAILABLE',
          '课程检索暂时不可用，请检查知识库状态。',
          503,
        );
      if (
        !record(value) ||
        value.question !== question ||
        !Array.isArray(value.sources) ||
        value.sources.length > 20
      )
        throw invalid();
      return value.sources.map(source);
    } catch (cause) {
      if (signal.aborted)
        throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
      if (expired)
        throw new ProgramServiceError(
          'COURSE_TIMEOUT',
          '课程检索响应超时。',
          504,
        );
      if (cause instanceof ProgramServiceError) throw cause;
      throw new ProgramServiceError(
        'COURSE_UNAVAILABLE',
        '无法连接课程检索服务。',
        503,
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  };
}
