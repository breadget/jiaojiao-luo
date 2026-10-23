import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

/**
 * 本机记录与项目的存放处。
 *
 * 位置由用户自己选（原生文件夹选择器或手填绝对路径），默认没有任何位置：
 * 没选之前不落盘。所有内容写在 `<root>/urtoris/<collection>/<id>.json`，
 * 权限 0600，写入是「临时文件 + rename」，不会留下半截文件。
 */

export const LOCAL_STORE_COLLECTIONS = [
  'conversations',
  'projects',
  'runs',
] as const;

export type LocalStoreCollection = (typeof LOCAL_STORE_COLLECTIONS)[number];

const COLLECTION_SET = new Set<string>(LOCAL_STORE_COLLECTIONS);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const ITEM_BYTES_LIMIT = 256 * 1024;
const FOLDER_NAME = 'urtoris';

export class LocalStoreError extends Error {
  constructor(
    public readonly code:
      | 'STORE_NOT_CONFIGURED'
      | 'INVALID_REQUEST'
      | 'STORE_UNAVAILABLE'
      | 'STORE_ITEM_MISSING',
    message: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'LocalStoreError';
  }
}

export type LocalStoreStatus = {
  root: string | null;
  folder: string | null;
  collections: Record<LocalStoreCollection, number>;
  updated_at: string | null;
};

function isCollection(value: string): value is LocalStoreCollection {
  return COLLECTION_SET.has(value);
}

export class LocalControlStore {
  private root: string | null = null;
  private updatedAt: string | null = null;

  constructor(private readonly configPath: string) {}

  async init(): Promise<void> {
    try {
      const raw = await readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw) as { root?: unknown; updated_at?: unknown };
      if (typeof parsed.root === 'string' && isAbsolute(parsed.root)) {
        this.root = parsed.root;
      }
      this.updatedAt = typeof parsed.updated_at === 'string' ? parsed.updated_at : null;
    } catch {
      // 还没有选过目录。
    }
  }

  requiresRoot(): string {
    if (!this.root) {
      throw new LocalStoreError(
        'STORE_NOT_CONFIGURED',
        '还没有选择保存位置。请先在设置里选一个文件夹。',
        409,
      );
    }
    return this.root;
  }

  async status(): Promise<LocalStoreStatus> {
    const counts = Object.fromEntries(
      LOCAL_STORE_COLLECTIONS.map((collection) => [collection, 0]),
    ) as Record<LocalStoreCollection, number>;
    if (this.root) {
      for (const collection of LOCAL_STORE_COLLECTIONS) {
        counts[collection] = (await this.list(collection, { tolerateMissing: true })).length;
      }
    }
    return {
      root: this.root,
      folder: this.root ? join(this.root, FOLDER_NAME) : null,
      collections: counts,
      updated_at: this.updatedAt,
    };
  }

  async setRoot(path: string): Promise<LocalStoreStatus> {
    const trimmed = path.trim();
    if (!trimmed || trimmed.includes('\0') || !isAbsolute(trimmed)) {
      throw new LocalStoreError('INVALID_REQUEST', '保存位置必须是绝对路径。');
    }
    const target = resolve(trimmed);
    if (target === sep) {
      throw new LocalStoreError('INVALID_REQUEST', '不能把保存位置设在磁盘根目录。');
    }
    try {
      await mkdir(target, { recursive: true, mode: 0o700 });
      const info = await stat(target);
      if (!info.isDirectory()) {
        throw new LocalStoreError('INVALID_REQUEST', '这个路径不是文件夹。');
      }
      const probe = join(target, `.urtoris-write-${randomBytes(4).toString('hex')}`);
      await writeFile(probe, 'ok', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await unlink(probe);
    } catch (cause) {
      if (cause instanceof LocalStoreError) throw cause;
      throw new LocalStoreError(
        'STORE_UNAVAILABLE',
        cause instanceof Error
          ? `这个文件夹写不进去：${cause.message}`
          : '这个文件夹写不进去。',
      );
    }
    this.root = target;
    this.updatedAt = new Date().toISOString();
    await mkdir(join(target, FOLDER_NAME), { recursive: true, mode: 0o700 });
    await writeFile(
      this.configPath,
      `${JSON.stringify({ root: target, updated_at: this.updatedAt }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await chmod(this.configPath, 0o600);
    return this.status();
  }

  private assertCollection(value: string): LocalStoreCollection {
    if (!isCollection(value)) {
      throw new LocalStoreError('INVALID_REQUEST', '不认识的记录类型。');
    }
    return value;
  }

  private assertId(id: string): string {
    if (!ID_PATTERN.test(id)) {
      throw new LocalStoreError('INVALID_REQUEST', '记录编号无效。');
    }
    return id;
  }

  private directory(collection: LocalStoreCollection): string {
    return join(this.requiresRoot(), FOLDER_NAME, collection);
  }

  private filePath(collection: LocalStoreCollection, id: string): string {
    const directory = this.directory(collection);
    const file = join(directory, `${id}.json`);
    if (!file.startsWith(`${directory}${sep}`)) {
      throw new LocalStoreError('INVALID_REQUEST', '记录路径越界。');
    }
    return file;
  }

  async list(
    collection: string,
    options: { tolerateMissing?: boolean } = {},
  ): Promise<Array<{ id: string; updated_at: string }>> {
    const name = this.assertCollection(collection);
    const directory = this.directory(name);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      if (options.tolerateMissing) return [];
      throw new LocalStoreError('STORE_UNAVAILABLE', '读不到这个记录目录。', 500);
    }
    const items: Array<{ id: string; updated_at: string }> = [];
    for (const entry of names) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -'.json'.length);
      if (!ID_PATTERN.test(id)) continue;
      const info = await stat(join(directory, entry)).catch(() => null);
      if (!info) continue;
      items.push({ id, updated_at: info.mtime.toISOString() });
    }
    return items.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  async read(collection: string, id: string): Promise<unknown> {
    const file = this.filePath(this.assertCollection(collection), this.assertId(id));
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      throw new LocalStoreError('STORE_ITEM_MISSING', '这条记录不存在。', 404);
    }
  }

  async write(collection: string, id: string, value: unknown): Promise<{ id: string; updated_at: string }> {
    const name = this.assertCollection(collection);
    const key = this.assertId(id);
    const serialised = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialised, 'utf8') > ITEM_BYTES_LIMIT) {
      throw new LocalStoreError(
        'INVALID_REQUEST',
        `单条记录不能超过 ${Math.round(ITEM_BYTES_LIMIT / 1024)} KB。`,
      );
    }
    const directory = this.directory(name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = this.filePath(name, key);
    const temporary = `${destination}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, serialised, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
    const info = await stat(destination);
    return { id: key, updated_at: info.mtime.toISOString() };
  }

  async remove(collection: string, id: string): Promise<void> {
    const file = this.filePath(this.assertCollection(collection), this.assertId(id));
    await rm(file, { force: true });
  }
}
