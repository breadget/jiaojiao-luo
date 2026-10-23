import {
  fetchProgramArtifact,
  ProgramClientError,
} from '@/lib/server/workflow-program-client';
import {
  ownedProgramJob,
  programErrorResponse,
  readOwnedProgramJob,
} from '@/lib/server/workflow-program-store';
import {
  enforceExecutionAccess,
  enforceRateLimit,
} from '@/lib/server/security';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; artifactId: string }> },
) {
  const denied =
    enforceExecutionAccess(request, { allowConsumerClientMarker: true }) ??
    enforceRateLimit(request, {
      label: 'program-download',
      limit: 30,
      windowMs: 60_000,
    });
  if (denied) return denied;
  try {
    const { id, artifactId } = await context.params;
    await ownedProgramJob(request, id);
    const job = await readOwnedProgramJob(request, id);
    const artifact = job.artifacts.find((item) => item.id === artifactId);
    if (!artifact)
      return Response.json({ error: '这个程序文件不存在。' }, { status: 404 });
    const upstream = await fetchProgramArtifact(id, artifactId);
    if (!upstream.body) throw new ProgramClientError('程序文件暂时无法下载。');
    const reader = upstream.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 4 * 1024 * 1024 || size > artifact.sizeBytes) {
          await reader.cancel();
          throw new ProgramClientError('程序文件大小不匹配。', 502);
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    if (size !== artifact.sizeBytes)
      throw new ProgramClientError('程序文件不完整，请稍后重试。', 502);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const safeName =
      artifact.name.replace(/[\p{Cc}/\\]/gu, '_').slice(0, 180) || 'result.txt';
    return new Response(bytes, {
      headers: {
        'Content-Type':
          artifact.mimeType === 'text/markdown'
            ? 'text/markdown; charset=utf-8'
            : 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="result.${artifact.mimeType === 'text/markdown' ? 'md' : 'txt'}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
        'Content-Length': String(size),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (cause) {
    return programErrorResponse(cause);
  }
}
