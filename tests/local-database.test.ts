import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { LOCAL_DATABASE_LIMITS } from '../lib/local-database-protocol';
import {
  inspectDatabase,
  LocalDatabaseError,
  queryDatabase,
  validateReadOnlySql,
} from '../services/local-database';

describe('local SQLite database', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'urtoris-sqlite-test-'));
    filePath = join(directory, 'orders.db');
    const database = new DatabaseSync(filePath);
    database.exec(`
      CREATE TABLE orders (id INTEGER PRIMARY KEY, customer TEXT NOT NULL, total REAL, payload BLOB, large_integer INTEGER);
      INSERT INTO orders VALUES (1, '小明', 12.5, x'00FF', 9223372036854775807);
      INSERT INTO orders VALUES (2, '小红', NULL, NULL, 7);
      INSERT INTO orders VALUES (3, 'O''Brien', 20, NULL, NULL);
      CREATE VIEW order_totals AS SELECT customer, total FROM orders;
    `);
    database.close();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const hasCode = (code: string) => (error: unknown) =>
    error instanceof LocalDatabaseError && error.code === code;

  it('inspects a real existing file, its tables, views and column types', async () => {
    const before = await readFile(filePath);
    const schema = await inspectDatabase(filePath);
    assert.equal(schema.filePath, await realpath(filePath));
    assert.equal(schema.truncated, false);
    assert.deepEqual(
      schema.tables.map((table) => [table.name, table.kind]),
      [
        ['order_totals', 'view'],
        ['orders', 'table'],
      ],
    );
    assert.deepEqual(schema.tables[1].columns[1], {
      name: 'customer',
      type: 'TEXT',
      nullable: false,
      primaryKey: false,
    });
    assert.equal(schema.tables[1].columns[0].primaryKey, true);
    assert.deepEqual(await readFile(filePath), before);
  });

  it('queries parameters without SQL interpolation and serializes exact integers and blobs', async () => {
    const result = await queryDatabase({
      filePath,
      sql: 'SELECT id, customer, total, payload, large_integer FROM orders WHERE id = ?',
      parameters: [1],
    });
    assert.deepEqual(result.columns, [
      'id',
      'customer',
      'total',
      'payload',
      'large_integer',
    ]);
    assert.deepEqual(result.rows, [
      [
        1,
        '小明',
        12.5,
        { type: 'blob', base64: 'AP8=', bytes: 2 },
        { type: 'integer', value: '9223372036854775807' },
      ],
    ]);
    assert.equal(result.rowCount, 1);
    assert.equal(result.truncated, false);
    const named = await queryDatabase({
      filePath,
      sql: 'SELECT customer FROM orders WHERE customer = :customer',
      parameters: { customer: "O'Brien" },
    });
    assert.deepEqual(named.rows, [["O'Brien"]]);
    const injection = await queryDatabase({
      filePath,
      sql: 'SELECT customer FROM orders WHERE customer = ?',
      parameters: ["'; DROP TABLE orders; --"],
    });
    assert.deepEqual(injection.rows, []);
  });

  it('preserves column order, repeated names, NULL, and empty result metadata', async () => {
    const probe = new DatabaseSync(':memory:');
    const supportsMetadata =
      typeof (probe.prepare('SELECT 1') as unknown as { columns?: unknown })
        .columns === 'function';
    probe.close();
    const result = await queryDatabase({
      filePath,
      sql: 'SELECT id AS value, customer AS value, total FROM orders WHERE id = 2',
    });
    assert.deepEqual(
      result.columns,
      supportsMetadata ? ['value', 'value', 'total'] : ['value', 'total'],
    );
    assert.deepEqual(
      result.rows,
      supportsMetadata ? [[2, '小红', null]] : [['小红', null]],
    );
    const empty = await queryDatabase({
      filePath,
      sql: 'SELECT id, customer FROM orders WHERE id = 99',
    });
    assert.deepEqual(empty.columns, supportsMetadata ? ['id', 'customer'] : []);
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.truncated, false);
  });

  it('supports a read-only WITH query and SQL comments or quoted semicolons', async () => {
    const result = await queryDatabase({
      filePath,
      sql: "/* read */ WITH matches AS (SELECT customer FROM orders WHERE id = ?) SELECT customer, '; ATTACH' AS note FROM matches; -- done",
      parameters: [1],
    });
    assert.deepEqual(result.rows, [['小明', '; ATTACH']]);
    assert.equal(
      validateReadOnlySql('SELECT "update", [delete], `attach`, \'pragma\''),
      'SELECT "update", [delete], `attach`, \'pragma\'',
    );
  });

  it('rejects writes, ATTACH, extensions, and multiple statements without changing the file', async () => {
    const before = await readFile(filePath);
    const forbidden = [
      'DELETE FROM orders',
      "UPDATE orders SET customer = 'Changed' WHERE id = 1",
      'WITH selected AS (SELECT 1) DELETE FROM orders',
      "ATTACH DATABASE '/tmp/other.db' AS other",
      "SELECT load_extension('/tmp/dangerous.so')",
      "SELECT readfile('/tmp/private.txt')",
      'PRAGMA journal_mode = OFF',
      'SELECT id FROM orders; DELETE FROM orders',
      'SELECT id FROM orders; /* comment */ SELECT customer FROM orders',
    ];
    for (const sql of forbidden) {
      await assert.rejects(
        queryDatabase({ filePath, sql }),
        hasCode('READ_ONLY_QUERY_REQUIRED'),
      );
    }
    // Quoting an extension function cannot bypass SQLite's own disabled loader.
    await assert.rejects(
      queryDatabase({
        filePath,
        sql: 'SELECT "load_extension"(?)',
        parameters: ['/tmp/dangerous.so'],
      }),
      hasCode('SQLITE_QUERY_FAILED'),
    );
    assert.deepEqual(await readFile(filePath), before);
    assert.deepEqual(
      (
        await queryDatabase({
          filePath,
          sql: 'SELECT count(*) AS count FROM orders',
        })
      ).rows,
      [[3]],
    );
  });

  it('does not create missing files and rejects directories, relative paths and non-SQLite files', async () => {
    const missing = join(directory, 'missing.sqlite');
    await assert.rejects(
      inspectDatabase(missing),
      hasCode('DATABASE_FILE_NOT_FOUND'),
    );
    await assert.rejects(readFile(missing), { code: 'ENOENT' });
    await assert.rejects(
      inspectDatabase(directory),
      hasCode('INVALID_SQLITE_FILE'),
    );
    await assert.rejects(
      inspectDatabase('orders.db'),
      hasCode('INVALID_REQUEST'),
    );
    const text = join(directory, 'text.db');
    await writeFile(text, 'this is not SQLite');
    await assert.rejects(inspectDatabase(text), hasCode('INVALID_SQLITE_FILE'));
  });

  it('bounds rows and response bytes with explicit truncation', async () => {
    const limited = await queryDatabase({
      filePath,
      sql: 'SELECT id FROM orders ORDER BY id',
      maxRows: 2,
    });
    assert.deepEqual(limited.rows, [[1], [2]]);
    assert.equal(limited.truncated, true);
    const exact = await queryDatabase({
      filePath,
      sql: 'SELECT id FROM orders WHERE id <= 2 ORDER BY id',
      maxRows: 2,
    });
    assert.equal(exact.truncated, false);
    const oversized = await queryDatabase({
      filePath,
      sql: 'SELECT zeroblob(300000) AS data',
    });
    assert.deepEqual(oversized.rows, []);
    assert.equal(oversized.truncated, true);
    assert.ok(
      Buffer.byteLength(JSON.stringify(oversized), 'utf8') <
        LOCAL_DATABASE_LIMITS.resultBytes,
    );
    await assert.rejects(
      queryDatabase({ filePath, sql: 'SELECT 1', maxRows: 501 }),
      hasCode('INVALID_REQUEST'),
    );
  });

  it('bounds schema tables and columns', async () => {
    const database = new DatabaseSync(filePath);
    for (
      let index = 0;
      index < LOCAL_DATABASE_LIMITS.schemaTables;
      index += 1
    ) {
      database.exec(
        `CREATE TABLE table_${String(index).padStart(3, '0')} (id INTEGER)`,
      );
    }
    database.exec(
      `CREATE TABLE aaa_wide (${Array.from({ length: 101 }, (_, index) => `column_${index} TEXT`).join(', ')})`,
    );
    database.close();
    const schema = await inspectDatabase(filePath);
    assert.equal(schema.tables.length, LOCAL_DATABASE_LIMITS.schemaTables);
    assert.equal(schema.truncated, true);
    assert.equal(schema.tables[0].name, 'aaa_wide');
    assert.equal(
      schema.tables[0].columns.length,
      LOCAL_DATABASE_LIMITS.schemaColumns,
    );
    assert.equal(schema.tables[0].truncated, true);
  });

  it('kills an expensive native SQLite query at its deadline and remains responsive', async () => {
    const started = Date.now();
    let heartbeat = false;
    const interval = setInterval(() => {
      heartbeat = true;
    }, 20);
    try {
      await assert.rejects(
        queryDatabase({
          filePath,
          sql: 'WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 1000000000) SELECT sum(n) FROM numbers',
          timeoutMs: 150,
        }),
        hasCode('DATABASE_QUERY_TIMEOUT'),
      );
    } finally {
      clearInterval(interval);
    }
    assert.equal(heartbeat, true);
    assert.ok(Date.now() - started < 3_000);
    assert.deepEqual(
      (await queryDatabase({ filePath, sql: 'SELECT count(*) FROM orders' }))
        .rows,
      [[3]],
    );
  });

  it('validates invalid SQL and parameters and returns bounded query errors', async () => {
    for (const sql of [
      '',
      'SELECT \0',
      "SELECT 'unclosed",
      'SELECT 1 /* unclosed',
    ]) {
      await assert.rejects(
        queryDatabase({ filePath, sql }),
        hasCode('INVALID_REQUEST'),
      );
    }
    await assert.rejects(
      queryDatabase({
        filePath,
        sql: 'SELECT ?',
        parameters: [Number.POSITIVE_INFINITY],
      }),
      hasCode('INVALID_REQUEST'),
    );
    await assert.rejects(
      queryDatabase({ filePath, sql: 'SELECT ?', parameters: [true] as never }),
      hasCode('INVALID_REQUEST'),
    );
    await assert.rejects(
      queryDatabase({
        filePath,
        sql: 'SELECT private_secret FROM missing_table',
      }),
      (error: unknown) =>
        hasCode('SQLITE_QUERY_FAILED')(error) &&
        !(error as Error).message.includes('private_secret'),
    );
  });
});
