import { env } from 'cloudflare:workers';
import type {
  ProgramJob,
  ProgramStartRequest,
} from '@/lib/workflow-program/types';
import { PROGRAM_SNAPSHOT_MAX_BYTES } from '@/lib/workflow-program/types';

export class ProgramClientError extends Error {
  constructor(
    message: string,
    public readonly status = 503,
    public readonly code = 'PROGRAM_EXECUTOR_UNAVAILABLE',
  ) {
    super(message);
    this.name = 'ProgramClientError';
  }
}

function config() {
  const token = env.WORKFLOW_PROGRAM_TOKEN?.trim() ?? '';
  const raw = env.WORKFLOW_PROGRAM_URL?.trim() ?? '';
  if (token.length < 32 || !raw)
    throw new ProgramClientError('后台程序执行器尚未连接，请稍后重试。');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProgramClientError('后台程序执行器配置无效。');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', '::1'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new ProgramClientError('后台程序执行器配置无效。');
  return { url, token };
}

export function programExecutorConfigured(): boolean {
  try {
    config();
    return true;
  } catch {
    return false;
  }
}

async function request(
  path: string,
  method: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<Response> {
  const { url, token } = config();
  if (
    !/^\/v1\/jobs(?:\/program_[a-f0-9]{32}(?:\/artifacts\/[A-Za-z0-9_-]{1,100})?)?$/.test(
      path,
    )
  )
    throw new ProgramClientError('程序请求路径无效。', 400);
  const response = await fetch(new URL(path, url), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
    redirect: 'manual',
  });
  if (
    response.type === 'opaqueredirect' ||
    (response.status >= 300 && response.status < 400)
  )
    throw new ProgramClientError('后台程序执行器返回了无效响应。', 502);
  if (!response.ok) {
    await response.body?.cancel();
    const status = [400, 408].includes(response.status)
      ? response.status
      : response.status === 404
        ? 404
        : response.status === 409
          ? 409
          : response.status === 429
            ? 429
            : 503;
    throw new ProgramClientError(
      status === 404
        ? '这次程序运行不存在。'
        : status === 409
          ? '这次运行编号已经绑定了其他输入。'
          : status === 429
            ? '后台任务已满，请稍后再运行。'
            : '后台程序执行器暂时无法处理请求。',
      status,
    );
  }
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  if (
    !response.headers
      .get('Content-Type')
      ?.toLowerCase()
      .startsWith('application/json') ||
    !response.body
  )
    throw new ProgramClientError('后台程序执行器返回了无效数据。', 502);
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > PROGRAM_SNAPSHOT_MAX_BYTES) {
        await reader.cancel();
        throw new ProgramClientError('程序运行结果超过读取上限。', 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all));
  } catch {
    throw new ProgramClientError('后台程序执行器返回了无效数据。', 502);
  }
}

export function normalizeProgramJob(value: unknown, id: string): ProgramJob {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProgramClientError('程序运行数据无效。', 502);
  const job = value as ProgramJob;
  if (
    job.id !== id ||
    typeof job.workflowId !== 'string' ||
    typeof job.versionId !== 'string' ||
    !Number.isInteger(job.workflowVersion) ||
    !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(
      job.status,
    ) ||
    !job.input ||
    typeof job.input !== 'object' ||
    Array.isArray(job.input) ||
    !job.nodes ||
    typeof job.nodes !== 'object' ||
    Array.isArray(job.nodes) ||
    Object.keys(job.nodes).length > 100 ||
    !Array.isArray(job.artifacts) ||
    job.artifacts.length > 20 ||
    !Number.isSafeInteger(job.createdAt) ||
    job.createdAt < 0 ||
    (job.startedAt != null &&
      (!Number.isSafeInteger(job.startedAt) || job.startedAt < 0)) ||
    (job.finishedAt != null &&
      (!Number.isSafeInteger(job.finishedAt) || job.finishedAt < 0)) ||
    (['completed', 'failed', 'cancelled'].includes(job.status) &&
      job.finishedAt == null) ||
    (['queued', 'running'].includes(job.status) && job.finishedAt != null)
  )
    throw new ProgramClientError('程序运行数据无效。', 502);
  for (const [nodeId, node] of Object.entries(job.nodes)) {
    if (
      !node ||
      typeof node.id !== 'string' ||
      node.id !== nodeId ||
      typeof node.name !== 'string' ||
      node.name.length > 200 ||
      (node.startedAt !== undefined && !Number.isSafeInteger(node.startedAt)) ||
      (node.finishedAt !== undefined &&
        !Number.isSafeInteger(node.finishedAt)) ||
      (node.error !== undefined && typeof node.error !== 'string') ||
      !['waiting', 'running', 'success', 'error', 'skipped'].includes(
        node.state,
      )
    )
      throw new ProgramClientError('程序节点状态无效。', 502);
  }
  for (const artifact of job.artifacts) {
    if (
      !artifact ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(artifact.id) ||
      typeof artifact.name !== 'string' ||
      !['text/plain', 'text/markdown'].includes(artifact.mimeType) ||
      !Number.isFinite(artifact.sizeBytes) ||
      artifact.sizeBytes < 0 ||
      artifact.sizeBytes > 4 * 1024 * 1024
    )
      throw new ProgramClientError('程序文件数据无效。', 502);
  }
  if (job.result != null) {
    if (
      typeof job.result !== 'object' ||
      typeof job.result.text !== 'string' ||
      !Array.isArray(job.result.sources) ||
      job.result.sources.length > 20
    )
      throw new ProgramClientError('程序输出数据无效。', 502);
    for (const source of job.result.sources) {
      if (
        !source ||
        typeof source.id !== 'string' ||
        typeof source.filename !== 'string' ||
        !Number.isInteger(source.page) ||
        source.page < 1 ||
        typeof source.excerpt !== 'string' ||
        !Number.isFinite(source.score)
      )
        throw new ProgramClientError('程序引用数据无效。', 502);
    }
  }
  if (
    job.result?.model &&
    (typeof job.result.model.provider !== 'string' ||
      typeof job.result.model.model !== 'string')
  )
    throw new ProgramClientError('程序模型记录无效。', 502);
  if (job.status === 'completed' && !job.result)
    throw new ProgramClientError('程序完成结果缺失。', 502);
  if (
    job.error &&
    (typeof job.error.code !== 'string' ||
      typeof job.error.message !== 'string')
  )
    throw new ProgramClientError('程序错误数据无效。', 502);
  // Only the public snapshot fields cross the browser boundary.
  return {
    id: job.id,
    workflowId: job.workflowId,
    workflowVersion: job.workflowVersion,
    versionId: job.versionId,
    status: job.status,
    input: job.input,
    nodes: Object.fromEntries(
      Object.entries(job.nodes).map(([key, node]) => [
        key,
        {
          id: node.id,
          name: node.name,
          state: node.state,
          ...(node.startedAt === undefined
            ? {}
            : { startedAt: node.startedAt }),
          ...(node.finishedAt === undefined
            ? {}
            : { finishedAt: node.finishedAt }),
          ...(node.input === undefined ? {} : { input: node.input }),
          ...(node.output === undefined ? {} : { output: node.output }),
          ...(node.error === undefined ? {} : { error: node.error }),
        },
      ]),
    ),
    result: job.result
      ? {
          text: job.result.text,
          ...(job.result.model
            ? {
                model: {
                  provider: job.result.model.provider,
                  model: job.result.model.model,
                },
              }
            : {}),
          sources: job.result.sources.map((source) => ({
            id: source.id,
            filename: source.filename,
            page: source.page,
            excerpt: source.excerpt,
            score: source.score,
          })),
          ...(job.result.data === undefined ? {} : { data: job.result.data }),
        }
      : null,
    artifacts: job.artifacts.map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
    })),
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    ...(job.error
      ? { error: { code: job.error.code, message: job.error.message } }
      : {}),
  };
}

async function jsonRequest(
  path: string,
  method: string,
  id: string,
  body?: unknown,
): Promise<ProgramJob> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new ProgramClientError(
          '后台程序响应超时，请查看运行状态后再重试。',
          504,
        ),
      );
    }, 12_000);
  });
  try {
    return await Promise.race([
      (async () =>
        normalizeProgramJob(
          await readJson(await request(path, method, controller.signal, body)),
          id,
        ))(),
      timeout,
    ]);
  } catch (cause) {
    if (cause instanceof ProgramClientError) throw cause;
    throw new ProgramClientError('后台程序执行器暂时无法连接。');
  } finally {
    clearTimeout(timer!);
  }
}

export function submitProgramJob(input: ProgramStartRequest) {
  return jsonRequest('/v1/jobs', 'POST', input.id, input);
}
export function fetchProgramJob(id: string) {
  return jsonRequest(`/v1/jobs/${id}`, 'GET', id);
}
export function cancelProgramJob(id: string) {
  return jsonRequest(`/v1/jobs/${id}`, 'DELETE', id);
}
export async function fetchProgramArtifact(id: string, artifactId: string) {
  try {
    return await request(
      `/v1/jobs/${id}/artifacts/${artifactId}`,
      'GET',
      AbortSignal.timeout(15_000),
    );
  } catch (cause) {
    if (cause instanceof ProgramClientError) throw cause;
    throw new ProgramClientError('程序文件暂时无法下载。');
  }
}
