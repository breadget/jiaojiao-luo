/**
 * 测试用的 D1 替身：直接跑在 Node 内置的 SQLite 上。
 *
 * 为什么不写一个"内存字典 + SQL 正则匹配"的假实现：Graph 草稿的乐观锁、
 * `workflow_versions` 的不可变约束、绑定表的主键冲突，全都是**数据库语义**。
 * 只有真的执行 SQL 才能验证 revision 409、UNIQUE 约束和 batch 原子性。
 *
 * 覆盖到的 D1 API：prepare / bind / first / all / run / batch / exec。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

type SqlValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, unknown>;

export type D1Meta = {
  changes: number;
  last_row_id: number;
  duration: number;
  rows_read: number;
  rows_written: number;
};

export type D1Result<T> = {
  success: true;
  results: T[];
  meta: D1Meta;
};

/** D1 接受 boolean / Date，SQLite 的绑定参数不接受，这里统一收口。 */
function bindable(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'bigint'
  ) {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.getTime();
  // 兜底：D1 也只接受标量与字节数组。这里直接报错，而不是悄悄绑定成
  // "[object Object]" —— 后者会让测试通过、生产出错。
  throw new Error(`不支持的绑定参数类型：${typeof value}`);
}

function meta(changes: number, lastRowId: number, rowsRead: number): D1Meta {
  return {
    changes,
    last_row_id: lastRowId,
    duration: 0,
    rows_read: rowsRead,
    rows_written: changes,
  };
}

class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly params: SqlValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, values.map(bindable));
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    if (column) return (row[column] ?? null) as T;
    return row as T;
  }

  async all<T = Row>(): Promise<D1Result<T>> {
    const rows = this.db.prepare(this.sql).all(...this.params) as T[];
    return { success: true, results: rows, meta: meta(0, 0, rows.length) };
  }

  async run<T = Row>(): Promise<D1Result<T>> {
    const result = this.db.prepare(this.sql).run(...this.params);
    return {
      success: true,
      results: [],
      meta: meta(
        Number(result.changes),
        Number(result.lastInsertRowid),
        0,
      ),
    };
  }
}

/** 直接落到 SQLite 的 D1 兼容层。 */
export class SqliteD1 {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string) {
    return new SqliteStatement(this.db, sql);
  }

  /** D1 的 batch 是隐式事务；这里用显式事务实现同等语义。 */
  async batch<T = Row>(statements: SqliteStatement[]): Promise<D1Result<T>[]> {
    this.db.exec('BEGIN');
    try {
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
        results.push((await statement.run()) as D1Result<T>);
      }
      this.db.exec('COMMIT');
      return results;
    } catch (cause) {
      this.db.exec('ROLLBACK');
      throw cause;
    }
  }

  async exec(sql: string) {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }

  /** 只给测试用：同步执行，方便灌 migration。 */
  execSync(sql: string) {
    this.db.exec(sql);
  }
}

export type TestDatabase = {
  d1: SqliteD1;
  raw: DatabaseSync;
  close: () => void;
};

const DRIZZLE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'drizzle',
);

/** 按文件名顺序读出 drizzle/ 下所有迁移，切成单条语句。 */
export function migrationStatements(): { file: string; sql: string }[] {
  const statements: { file: string; sql: string }[] = [];
  const files = readdirSync(DRIZZLE_DIR)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const file of files) {
    const content = readFileSync(join(DRIZZLE_DIR, file), 'utf8');
    for (const chunk of content.split('--> statement-breakpoint')) {
      const sql = chunk.trim();
      if (sql) statements.push({ file, sql });
    }
  }
  return statements;
}

/**
 * 建一个内存库并跑完全部迁移。
 * 传 `migrate: false` 可以拿到空库，用于验证"迁移缺失时行为可控"。
 */
export function createTestDatabase(options: { migrate?: boolean } = {}): TestDatabase {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const d1 = new SqliteD1(raw);
  if (options.migrate !== false) {
    for (const statement of migrationStatements()) {
      try {
        raw.exec(statement.sql);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `迁移 ${statement.file} 执行失败：${reason}\n${statement.sql}`,
        );
      }
    }
  }
  return { d1, raw, close: () => raw.close() };
}
