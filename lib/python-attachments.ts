/**
 * 使用端附件的共享规则（浏览器与服务端都能用，不含任何 Node API）。
 *
 * 与 Executor 侧的限额保持一致：单文件 25 MiB、最多 10 个、合计 50 MiB，
 * 支持常见文本、PDF、Office / OpenDocument 和图片附件。挂载名由前端生成安全的 ASCII
 * 单层文件名，原始文件名只作为展示名。
 */

export const PYTHON_ATTACHMENT_LIMITS = {
  files: 10,
  fileBytes: 25 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
} as const;

export const PYTHON_ATTACHMENT_EXTENSIONS = [
  '.csv',
  '.json',
  '.txt',
  '.pdf',
  '.doc',
  '.docx',
  '.rtf',
  '.odt',
  '.ppt',
  '.pptx',
  '.odp',
  '.xls',
  '.xlsx',
  '.ods',
  '.png',
  '.jpg',
  '.jpeg',
] as const;

const EXTENSION_MIME: ReadonlyMap<string, string> = new Map([
  ['.csv', 'text/csv'],
  ['.json', 'application/json'],
  ['.txt', 'text/plain'],
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  [
    '.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  ['.rtf', 'application/rtf'],
  ['.odt', 'application/vnd.oasis.opendocument.text'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  [
    '.pptx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  ['.odp', 'application/vnd.oasis.opendocument.presentation'],
  ['.xls', 'application/vnd.ms-excel'],
  [
    '.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
  ['.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
]);

export function attachmentExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLowerCase();
}

export function isSupportedAttachment(name: string): boolean {
  return EXTENSION_MIME.has(attachmentExtension(name));
}

export function attachmentMimeType(name: string): string {
  return (
    EXTENSION_MIME.get(attachmentExtension(name)) ?? 'application/octet-stream'
  );
}

/** 浏览器 file input 的 accept 值。 */
export const PYTHON_ATTACHMENT_ACCEPT = PYTHON_ATTACHMENT_EXTENSIONS.join(',');

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

/**
 * 生成 `input/` 下的安全挂载名。原始中文名、带空格的名字都不适合直接当挂载名，
 * 所以按序号 + 扩展名生成，展示名仍用用户原始文件名。
 */
export function mountNameFor(index: number, name: string): string {
  const extension = attachmentExtension(name);
  const safeExtension = EXTENSION_MIME.has(extension) ? extension : '.txt';
  return `file-${index + 1}${safeExtension}`;
}

export function validateAttachments(
  files: ReadonlyArray<{ name: string; size: number }>,
): { ok: true } | { ok: false; error: string } {
  if (files.length > PYTHON_ATTACHMENT_LIMITS.files) {
    return {
      ok: false,
      error: `一次最多上传 ${PYTHON_ATTACHMENT_LIMITS.files} 个文件。`,
    };
  }
  let total = 0;
  for (const file of files) {
    if (!isSupportedAttachment(file.name)) {
      return {
        ok: false,
        error: `不支持的文件类型：${file.name}。只支持 ${PYTHON_ATTACHMENT_EXTENSIONS.join('、')}。`,
      };
    }
    if (file.size <= 0) {
      return { ok: false, error: `文件是空的：${file.name}。` };
    }
    if (file.size > PYTHON_ATTACHMENT_LIMITS.fileBytes) {
      return {
        ok: false,
        error: `单个文件不能超过 ${formatBytes(PYTHON_ATTACHMENT_LIMITS.fileBytes)}：${file.name}。`,
      };
    }
    total += file.size;
  }
  if (total > PYTHON_ATTACHMENT_LIMITS.totalBytes) {
    return {
      ok: false,
      error: `附件合计不能超过 ${formatBytes(PYTHON_ATTACHMENT_LIMITS.totalBytes)}。`,
    };
  }
  return { ok: true };
}

/** 把已上传的附件整理成 `/api/python/agent` 的 inputs。 */
export function toAgentInputs(
  uploaded: ReadonlyArray<{
    fileId: string;
    mountName: string;
    name: string;
    size: number;
  }>,
): Array<{
  fileId: string;
  mountName: string;
  displayName: string;
  sizeBytes: number;
}> {
  return uploaded.map((file) => ({
    fileId: file.fileId,
    mountName: file.mountName,
    displayName: file.name.slice(0, 120),
    sizeBytes: file.size,
  }));
}
