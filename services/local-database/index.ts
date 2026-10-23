import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fork } from 'node:child_process';
import {
  LOCAL_DATABASE_LIMITS,
  LOCAL_DATABASE_PROTOCOL,
  type LocalDatabaseErrorCode,
  type LocalDatabaseParameters,
  type LocalDatabaseQueryRequest,
  type LocalDatabaseQueryResult,
  type LocalDatabaseSchema,
} from '../../lib/local-database-protocol';

export class LocalDatabaseError extends Error {
  constructor(
    public readonly code: LocalDatabaseErrorCode,
    message: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'LocalDatabaseError';
  }
}

const FORBIDDEN_SQL_WORDS = new Set([
  'ATTACH',
  'DETACH',
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'CREATE',
  'DROP',
  'ALTER',
  'VACUUM',
  'REINDEX',
  'ANALYZE',
  'PRAGMA',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'LOAD_EXTENSION',
  'READFILE',
  'WRITEFILE',
  'FTS3_TOKENIZER',
]);

/**
 * SQLite does not expose stmt_readonly on every supported Node release. Keep a
 * small lexical boundary as well as opening the file read-only. SQL strings,
 * quoted identifiers and comments are skipped; a semicolon can only terminate
 * the single statement. Unquoted mutation/attachment/extension tokens fail.
 */
export function validateReadOnlySql(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    value.length > LOCAL_DATABASE_LIMITS.sqlCharacters
  ) {
    throw new LocalDatabaseError(
      'INVALID_REQUEST',
      '查询 SQL 为空、过长或包含无效字符。',
    );
  }
  const sql = value.trim();
  const words: string[] = [];
  let terminated = false;
  for (let cursor = 0; cursor < sql.length;) {
    const character = sql[cursor];
    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }
    if (sql.startsWith('--', cursor)) {
      const nextLine = sql.indexOf('\n', cursor + 2);
      cursor = nextLine < 0 ? sql.length : nextLine + 1;
      continue;
    }
    if (sql.startsWith('/*', cursor)) {
      const end = sql.indexOf('*/', cursor + 2);
      if (end < 0)
        throw new LocalDatabaseError('INVALID_REQUEST', 'SQL 注释没有结束。');
      cursor = end + 2;
      continue;
    }
    if (terminated) {
      throw new LocalDatabaseError(
        'READ_ONLY_QUERY_REQUIRED',
        '每次只能执行一条只读查询。',
      );
    }
    if (character === ';') {
      terminated = true;
      cursor += 1;
      continue;
    }
    if (
      character === "'" ||
      character === '"' ||
      character === '`' ||
      character === '['
    ) {
      const closer = character === '[' ? ']' : character;
      let closed = false;
      cursor += 1;
      while (cursor < sql.length) {
        if (sql[cursor] !== closer) {
          cursor += 1;
          continue;
        }
        if (closer !== ']' && sql[cursor + 1] === closer) {
          cursor += 2;
          continue;
        }
        cursor += 1;
        closed = true;
        break;
      }
      if (!closed)
        throw new LocalDatabaseError('INVALID_REQUEST', 'SQL 引号没有结束。');
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(sql.slice(cursor))?.[0];
    if (word) {
      const upper = word.toUpperCase();
      if (FORBIDDEN_SQL_WORDS.has(upper)) {
        throw new LocalDatabaseError(
          'READ_ONLY_QUERY_REQUIRED',
          '数据库仅允许 SELECT 或 WITH 只读查询，不能改写文件、连接其他数据库或加载扩展。',
        );
      }
      words.push(upper);
      cursor += word.length;
    } else {
      cursor += 1;
    }
  }
  if (words[0] !== 'SELECT' && words[0] !== 'WITH') {
    throw new LocalDatabaseError(
      'READ_ONLY_QUERY_REQUIRED',
      '数据库仅允许 SELECT 或 WITH 只读查询。',
    );
  }
  return sql;
}

function parameters(value: unknown): LocalDatabaseParameters {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object') {
    throw new LocalDatabaseError(
      'INVALID_REQUEST',
      '查询参数必须是数组或命名参数对象。',
    );
  }
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry])
    : Object.entries(value);
  if (entries.length > LOCAL_DATABASE_LIMITS.parameterCount) {
    throw new LocalDatabaseError('INVALID_REQUEST', '查询参数过多。');
  }
  for (const [key, entry] of entries) {
    if (
      (!Array.isArray(value) &&
        !/^[$:@]?[A-Za-z_][A-Za-z_0-9]{0,79}$/.test(key as string)) ||
      (entry !== null &&
        typeof entry !== 'string' &&
        typeof entry !== 'number') ||
      (typeof entry === 'number' && !Number.isFinite(entry)) ||
      (typeof entry === 'string' &&
        entry.length > LOCAL_DATABASE_LIMITS.parameterStringCharacters)
    ) {
      throw new LocalDatabaseError(
        'INVALID_REQUEST',
        '查询参数只支持有限数字、字符串和 null。',
      );
    }
  }
  if (
    Buffer.byteLength(JSON.stringify(value), 'utf8') >
    LOCAL_DATABASE_LIMITS.requestBytes
  ) {
    throw new LocalDatabaseError('INVALID_REQUEST', '查询参数太大。');
  }
  return value as LocalDatabaseParameters;
}

async function existingDatabase(value: unknown): Promise<string> {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    !isAbsolute(value.trim()) ||
    value.includes('\0') ||
    value.length > LOCAL_DATABASE_LIMITS.filePathCharacters
  ) {
    throw new LocalDatabaseError(
      'INVALID_REQUEST',
      '数据库位置必须是电脑上现有 SQLite 文件的绝对路径。',
    );
  }
  try {
    const filePath = await realpath(value.trim());
    if (!(await stat(filePath)).isFile()) {
      throw new LocalDatabaseError(
        'INVALID_SQLITE_FILE',
        '数据库位置指向的不是文件。',
      );
    }
    const file = await open(filePath, 'r');
    try {
      const header = Buffer.alloc(16);
      const read = await file.read(header, 0, header.length, 0);
      if (
        read.bytesRead !== 16 ||
        header.toString('ascii') !== 'SQLite format 3\0'
      ) {
        throw new LocalDatabaseError(
          'INVALID_SQLITE_FILE',
          '这个文件不是 SQLite 数据库。',
        );
      }
    } finally {
      await file.close();
    }
    return filePath;
  } catch (cause) {
    if (cause instanceof LocalDatabaseError) throw cause;
    const code = (cause as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new LocalDatabaseError(
        'DATABASE_FILE_NOT_FOUND',
        '没有找到这个数据库文件。请检查文件位置。',
        404,
      );
    }
    throw new LocalDatabaseError(
      'DATABASE_FILE_UNAVAILABLE',
      '无法读取这个数据库文件。请检查当前用户的文件权限。',
      403,
    );
  }
}

function timeoutMilliseconds(value: unknown): number {
  if (value === undefined) return LOCAL_DATABASE_LIMITS.defaultTimeoutMs;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > LOCAL_DATABASE_LIMITS.maximumTimeoutMs
  ) {
    throw new LocalDatabaseError(
      'INVALID_REQUEST',
      '查询超时必须是 1 到 10000 毫秒的整数。',
    );
  }
  return value;
}

type WorkerResponse<T> =
  | { ok: true; result: T }
  | { ok: false; code: LocalDatabaseErrorCode; message: string };

async function runWorker<T>(
  operation: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const worker = fork(new URL('./worker.mjs', import.meta.url), [], {
      // A process can be SIGKILLed even inside a synchronous SQLite native call;
      // Worker.terminate cannot guarantee that boundary. No model credentials,
      // test hooks, or TS loader are inherited by this plain JavaScript process.
      execArgv: ['--max-old-space-size=64'],
      env: { NODE_ENV: 'production' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
    });
    const finish = (error: LocalDatabaseError | null, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.kill('SIGKILL');
      if (error) reject(error);
      else resolve(result as T);
    };
    const timer = setTimeout(
      () =>
        finish(
          new LocalDatabaseError(
            'DATABASE_QUERY_TIMEOUT',
            '数据库查询耗时过长，已停止。请缩小查询范围。',
            408,
          ),
        ),
      timeoutMs,
    );
    worker.once('message', (response: WorkerResponse<T>) => {
      if (response.ok) finish(null, response.result);
      else
        finish(
          new LocalDatabaseError(
            response.code,
            response.message,
            response.code === 'DATABASE_RUNTIME_UNAVAILABLE' ? 503 : 400,
          ),
        );
    });
    worker.once('error', () =>
      finish(
        new LocalDatabaseError(
          'DATABASE_RUNTIME_UNAVAILABLE',
          '本机 SQLite 查询进程无法运行。请使用 Node.js 22.13 或更新版本。',
          503,
        ),
      ),
    );
    worker.once('exit', (code) => {
      if (!settled)
        finish(
          new LocalDatabaseError(
            'DATABASE_RUNTIME_UNAVAILABLE',
            `本机 SQLite 查询进程提前退出（${code}）。`,
            503,
          ),
        );
    });
    worker.send({
      ...operation,
      protocol: LOCAL_DATABASE_PROTOCOL,
      limits: LOCAL_DATABASE_LIMITS,
    });
  });
}

export async function inspectDatabase(
  filePath: string,
): Promise<LocalDatabaseSchema> {
  const canonicalPath = await existingDatabase(filePath);
  return runWorker<LocalDatabaseSchema>(
    { kind: 'inspect', filePath: canonicalPath },
    LOCAL_DATABASE_LIMITS.defaultTimeoutMs,
  );
}

export async function queryDatabase(
  request: LocalDatabaseQueryRequest,
): Promise<LocalDatabaseQueryResult> {
  const sql = validateReadOnlySql(request.sql);
  const queryParameters = parameters(request.parameters);
  const maxRows = request.maxRows ?? LOCAL_DATABASE_LIMITS.defaultRows;
  if (
    !Number.isInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > LOCAL_DATABASE_LIMITS.maximumRows
  ) {
    throw new LocalDatabaseError(
      'INVALID_REQUEST',
      `最多返回行数必须是 1 到 ${LOCAL_DATABASE_LIMITS.maximumRows}。`,
    );
  }
  const timeoutMs = timeoutMilliseconds(request.timeoutMs);
  const filePath = await existingDatabase(request.filePath);
  return runWorker<LocalDatabaseQueryResult>(
    { kind: 'query', filePath, sql, parameters: queryParameters, maxRows },
    timeoutMs,
  );
}
