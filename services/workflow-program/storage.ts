import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import type {
  ProgramArtifact,
  ProgramJob,
} from '../../lib/workflow-program/types';
import {
  ARTIFACT_ID,
  JOB_ID,
  MAX_ARTIFACT_BYTES,
  MAX_SNAPSHOT_BYTES,
  ProgramServiceError,
  record,
} from './safety';

export type StoredProgramJob = { fingerprint: string; job: ProgramJob };

export class ProgramStorage {
  readonly root: string;
  constructor(root: string) {
    if (!isAbsolute(root))
      throw new Error('WORKFLOW_PROGRAM_STATE_DIR must be absolute.');
    this.root = resolve(root);
  }

  async init(): Promise<void> {
    let current = parse(this.root).root;
    for (const component of this.root
      .slice(current.length)
      .split(sep)
      .filter(Boolean)) {
      current = join(current, component);
      try {
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error('Unsafe program state directory.');
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        await mkdir(current, { mode: 0o700 });
      }
    }
    await this.assertDirectory(this.root);
  }

  private async assertDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(path)) !== path
    )
      throw new Error('Unsafe program state directory.');
  }

  private async jobDirectory(id: string, create = false): Promise<string> {
    if (!JOB_ID.test(id))
      throw new ProgramServiceError('NOT_FOUND', '程序任务不存在。', 404);
    await this.assertDirectory(this.root);
    const directory = join(this.root, id);
    if (create) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      }
    }
    await this.assertDirectory(directory);
    return directory;
  }

  private async atomicWrite(
    directory: string,
    target: string,
    bytes: Buffer,
  ): Promise<void> {
    await this.assertDirectory(directory);
    const temporary = join(
      directory,
      `.tmp_${randomBytes(16).toString('hex')}`,
    );
    const handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await this.assertDirectory(directory);
      await rename(temporary, join(directory, target));
      const dir = await open(
        directory,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async write(record: StoredProgramJob): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(record));
    if (bytes.length > MAX_SNAPSHOT_BYTES)
      throw new ProgramServiceError(
        'OUTPUT_TOO_LARGE',
        '程序运行记录过大。',
        500,
      );
    await this.atomicWrite(
      await this.jobDirectory(record.job.id, true),
      'job.json',
      bytes,
    );
  }

  async read(id: string): Promise<StoredProgramJob | null> {
    let handle;
    try {
      const directory = await this.jobDirectory(id);
      handle = await open(
        join(directory, 'job.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES)
        throw new Error('Invalid program snapshot.');
      const value: unknown = JSON.parse(await handle.readFile('utf8'));
      if (
        !record(value) ||
        !/^[a-f0-9]{64}$/.test(String(value.fingerprint)) ||
        !record(value.job) ||
        value.job.id !== id ||
        !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(
          String(value.job.status),
        )
      )
        throw new Error('Invalid program snapshot.');
      return value as StoredProgramJob;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw cause;
    } finally {
      await handle?.close();
    }
  }

  async all(): Promise<StoredProgramJob[]> {
    await this.assertDirectory(this.root);
    const entries = await readdir(this.root, { withFileTypes: true });
    const records: StoredProgramJob[] = [];
    for (const entry of entries) {
      if (
        !JOB_ID.test(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      )
        continue;
      const value = await this.read(entry.name);
      if (value) records.push(value);
    }
    return records;
  }

  async writeArtifact(
    id: string,
    artifact: ProgramArtifact,
    content: string,
  ): Promise<void> {
    if (!ARTIFACT_ID.test(artifact.id)) throw new Error('Invalid artifact ID.');
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > MAX_ARTIFACT_BYTES)
      throw new ProgramServiceError('OUTPUT_TOO_LARGE', '程序文件过大。', 500);
    const job = await this.jobDirectory(id);
    const directory = join(job, 'artifacts');
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    }
    await this.atomicWrite(directory, artifact.id, bytes);
  }

  async readArtifact(
    id: string,
    artifactId: string,
  ): Promise<{ artifact: ProgramArtifact; bytes: Buffer } | null> {
    if (!ARTIFACT_ID.test(artifactId)) return null;
    const value = await this.read(id);
    const artifact = value?.job.artifacts.find(
      (candidate) => candidate.id === artifactId,
    );
    if (!artifact) return null;
    const directory = join(await this.jobDirectory(id), 'artifacts');
    await this.assertDirectory(directory);
    const handle = await open(
      join(directory, artifactId),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size !== artifact.sizeBytes ||
        info.size > MAX_ARTIFACT_BYTES
      )
        return null;
      return { artifact, bytes: await handle.readFile() };
    } finally {
      await handle.close();
    }
  }
}
