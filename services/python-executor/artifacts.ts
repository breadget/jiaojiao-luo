import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import {
  EXECUTOR_LIMITS,
  SAFE_FILE_NAME_PATTERN,
  type PythonArtifact,
} from './protocol';

const ARTIFACT_MIME = new Map([
  ['.csv', 'text/csv'],
  ['.json', 'application/json'],
  ['.txt', 'text/plain'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  [
    '.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  [
    '.pptx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  [
    '.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
]);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PDF_SIGNATURE = Buffer.from('%PDF-', 'ascii');
const PDF_EOF = Buffer.from('%%EOF', 'ascii');

export class ArtifactRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactRejectedError';
  }
}

export type PngValidator = (
  path: string,
  maximumPixels: number,
) => Promise<void>;

export type XlsxValidator = (path: string) => Promise<void>;

export type PdfValidator = (path: string) => Promise<void>;

export type OfficeValidator = (path: string) => Promise<void>;

function safeOutputPath(root: string, name: string): string {
  const candidate = resolve(root, basename(name));
  if (!candidate.startsWith(`${resolve(root)}/`)) {
    throw new ArtifactRejectedError('Artifact path escaped the output root.');
  }
  return candidate;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

function validateText(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ArtifactRejectedError(`${label} must be valid UTF-8.`);
  }
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (
    bytes.byteLength < 24 ||
    !Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE)
  ) {
    throw new ArtifactRejectedError('PNG signature is invalid.');
  }
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new ArtifactRejectedError('PNG is missing its IHDR header.');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (
    width === 0 ||
    height === 0 ||
    width * height > EXECUTOR_LIMITS.pngPixels
  ) {
    throw new ArtifactRejectedError('PNG dimensions exceed the allowed limit.');
  }
  return { width, height };
}

function validatePdfEnvelope(bytes: Uint8Array, name: string): void {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    buffer.byteLength < PDF_SIGNATURE.byteLength + PDF_EOF.byteLength ||
    !buffer.subarray(0, PDF_SIGNATURE.byteLength).equals(PDF_SIGNATURE)
  ) {
    throw new ArtifactRejectedError(`PDF signature is invalid: ${name}.`);
  }
  const eofIndex = buffer.lastIndexOf(PDF_EOF);
  if (eofIndex < Math.max(0, buffer.byteLength - 2_048)) {
    throw new ArtifactRejectedError(`PDF end marker is invalid: ${name}.`);
  }
  const trailing = buffer.subarray(eofIndex + PDF_EOF.byteLength);
  if (
    trailing.some(
      (byte) => ![0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(byte),
    )
  ) {
    throw new ArtifactRejectedError(`PDF has unsafe trailing data: ${name}.`);
  }
}

async function validateCandidate(
  path: string,
  name: string,
  validators: {
    validatePng: PngValidator;
    validateXlsx: XlsxValidator;
    validatePdf: PdfValidator;
    validateDocx: OfficeValidator;
    validatePptx: OfficeValidator;
  },
): Promise<{
  name: string;
  path: string;
  mimeType: string;
  size: number;
  sha256: string;
}> {
  if (!SAFE_FILE_NAME_PATTERN.test(name)) {
    throw new ArtifactRejectedError(`Artifact name is invalid: ${name}.`);
  }
  const extension = extname(name).toLowerCase();
  const mimeType = ARTIFACT_MIME.get(extension);
  if (!mimeType) {
    throw new ArtifactRejectedError(`Artifact type is not allowed: ${name}.`);
  }

  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
    throw new ArtifactRejectedError(
      `Artifact is not a standalone regular file: ${name}.`,
    );
  }
  if (details.size > EXECUTOR_LIMITS.artifactFileBytes) {
    throw new ArtifactRejectedError(`Artifact is too large: ${name}.`);
  }

  if (extension === '.json' || extension === '.csv' || extension === '.txt') {
    const text = validateText(await readFile(path), name);
    if (extension === '.json') {
      try {
        JSON.parse(text);
      } catch {
        throw new ArtifactRejectedError(`JSON artifact is invalid: ${name}.`);
      }
    }
  } else if (extension === '.png') {
    pngDimensions(await readFile(path));
    await validators.validatePng(path, EXECUTOR_LIMITS.pngPixels);
  } else if (extension === '.xlsx') {
    const bytes = await readFile(path);
    if (
      bytes.byteLength < ZIP_SIGNATURE.byteLength ||
      !Buffer.from(bytes.subarray(0, 4)).equals(ZIP_SIGNATURE) ||
      !bytes.includes('[Content_Types].xml', 0, 'latin1')
    ) {
      throw new ArtifactRejectedError(
        `XLSX artifact is not a valid spreadsheet container: ${name}.`,
      );
    }
    // 真正的解析在第二个一次性容器里用 openpyxl 完成，不采信沙箱自述。
    await validators.validateXlsx(path);
  } else if (extension === '.pdf') {
    validatePdfEnvelope(await readFile(path), name);
    // 第二个一次性容器会完整解析 PDF，并拒绝脚本、动作、附件与加密内容。
    await validators.validatePdf(path);
  } else if (extension === '.docx' || extension === '.pptx') {
    const bytes = await readFile(path);
    if (
      bytes.byteLength < ZIP_SIGNATURE.byteLength ||
      !Buffer.from(bytes.subarray(0, 4)).equals(ZIP_SIGNATURE) ||
      !bytes.includes('[Content_Types].xml', 0, 'latin1')
    ) {
      throw new ArtifactRejectedError(
        `Office artifact is not a valid OOXML container: ${name}.`,
      );
    }
    if (extension === '.docx') await validators.validateDocx(path);
    else await validators.validatePptx(path);
  }

  return {
    name,
    path,
    mimeType,
    size: details.size,
    sha256: await sha256File(path),
  };
}

export async function validateAndPublishArtifacts(options: {
  outputDir: string;
  artifactRoot: string;
  validatePng: PngValidator;
  validateXlsx: XlsxValidator;
  validatePdf: PdfValidator;
  validateDocx: OfficeValidator;
  validatePptx: OfficeValidator;
}): Promise<PythonArtifact[]> {
  const entries = await readdir(options.outputDir, { withFileTypes: true });
  if (entries.length > EXECUTOR_LIMITS.artifacts) {
    throw new ArtifactRejectedError(
      `A run cannot produce more than ${EXECUTOR_LIMITS.artifacts} artifacts.`,
    );
  }

  const candidates = [];
  let totalBytes = 0;
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isFile()) {
      throw new ArtifactRejectedError(
        `Only direct regular files are allowed in output/: ${entry.name}.`,
      );
    }
    const candidate = await validateCandidate(
      safeOutputPath(options.outputDir, entry.name),
      entry.name,
      {
        validatePng: options.validatePng,
        validateXlsx: options.validateXlsx,
        validatePdf: options.validatePdf,
        validateDocx: options.validateDocx,
        validatePptx: options.validatePptx,
      },
    );
    totalBytes += candidate.size;
    if (totalBytes > EXECUTOR_LIMITS.artifactTotalBytes) {
      throw new ArtifactRejectedError(
        'The artifact total size limit was exceeded.',
      );
    }
    candidates.push(candidate);
  }

  await rm(options.artifactRoot, { recursive: true, force: true });
  await mkdir(options.artifactRoot, { recursive: true, mode: 0o700 });
  const artifacts: PythonArtifact[] = [];
  try {
    for (const candidate of candidates) {
      const artifactId = `artifact_${randomUUID().replaceAll('-', '')}`;
      const directory = join(options.artifactRoot, artifactId);
      await mkdir(directory, { mode: 0o700 });
      const destination = join(directory, candidate.name);
      await copyFile(candidate.path, destination);
      await chmod(destination, 0o400);
      artifacts.push({
        artifact_id: artifactId,
        name: candidate.name,
        mime_type: candidate.mimeType,
        size_bytes: candidate.size,
        sha256: candidate.sha256,
      });
    }
    return artifacts;
  } catch (cause) {
    await rm(options.artifactRoot, { recursive: true, force: true });
    await mkdir(options.artifactRoot, { recursive: true, mode: 0o700 });
    throw cause;
  }
}
