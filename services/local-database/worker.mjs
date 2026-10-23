// SQLite stays in a disposable Node process: synchronously expensive queries
// never block the local connector's HTTP thread and can be forcibly stopped.
import { Buffer } from 'node:buffer';

function scalar(value) {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : { type: 'integer', value: String(value) };
  }
  if (value instanceof Uint8Array) {
    return {
      type: 'blob',
      base64: Buffer.from(value).toString('base64'),
      bytes: value.byteLength,
    };
  }
  // SQLite accepts infinities; JSON cannot represent them as numeric values.
  if (typeof value === 'number' && !Number.isFinite(value))
    return String(value);
  return value;
}

process.once('message', async (workerData) => {
  const { limits, protocol, filePath } = workerData;
  let database;
  const send = (result) => process.send({ ok: true, result });
  try {
    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import('node:sqlite'));
    } catch {
      process.send({
        ok: false,
        code: 'DATABASE_RUNTIME_UNAVAILABLE',
        message: '请使用 Node.js 22.13 或更新版本启动本机数据库助手。',
      });
      return;
    }
    database = new DatabaseSync(filePath, {
      readOnly: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
    database.exec(
      'PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 1000;',
    );
    // Node 22.13 does not have these APIs. The read-only open mode and lexical
    // statement boundary remain mandatory independently of newer APIs.
    if (typeof database.enableDefensive === 'function')
      database.enableDefensive(true);
    if (workerData.kind === 'inspect') {
      const tableRows = database
        .prepare(
          "SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name LIMIT ?",
        )
        .all(limits.schemaTables + 1);
      const tables = [];
      let bytes = Buffer.byteLength(
        JSON.stringify({ protocol, filePath, tables: [], truncated: true }),
        'utf8',
      );
      let truncated = tableRows.length > limits.schemaTables;
      for (const table of tableRows.slice(0, limits.schemaTables)) {
        const rows = database
          .prepare(
            'SELECT name, type, "notnull", pk FROM pragma_table_info(?) LIMIT ?',
          )
          .all(table.name, limits.schemaColumns + 1);
        const entry = {
          name: table.name,
          kind: table.type,
          columns: rows.slice(0, limits.schemaColumns).map((column) => ({
            name: column.name,
            type: column.type,
            nullable: column.notnull === 0,
            primaryKey: column.pk > 0,
          })),
          truncated: rows.length > limits.schemaColumns,
        };
        const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
        if (bytes + entryBytes + 1 > limits.resultBytes) {
          truncated = true;
          break;
        }
        bytes += entryBytes + 1;
        tables.push(entry);
        if (entry.truncated) truncated = true;
      }
      send({ protocol, filePath, tables, truncated });
    } else {
      const statement = database.prepare(workerData.sql);
      statement.setReadBigInts(true);
      // Array results and column metadata arrived after Node 22.13. On the older
      // supported runtime use its row objects; empty results have no metadata and
      // callers should give selected columns unique aliases on that runtime.
      const hasArrayMetadata =
        typeof statement.columns === 'function' &&
        typeof statement.setReturnArrays === 'function';
      if (hasArrayMetadata) statement.setReturnArrays(true);
      const columns = hasArrayMetadata
        ? statement.columns().map((column) => column.name)
        : [];
      const rows = [];
      let truncated = false;
      let bytes = Buffer.byteLength(JSON.stringify(columns), 'utf8') + 128;
      if (bytes > limits.resultBytes) {
        send({ protocol, columns: [], rows: [], rowCount: 0, truncated: true });
        return;
      }
      const values = workerData.parameters;
      const iterator = Array.isArray(values)
        ? statement.iterate(...values)
        : statement.iterate(values);
      for (const rawRecord of iterator) {
        if (!hasArrayMetadata && columns.length === 0) {
          columns.push(...Object.keys(rawRecord));
          bytes = Buffer.byteLength(JSON.stringify(columns), 'utf8') + 128;
          if (bytes > limits.resultBytes) {
            send({
              protocol,
              columns: [],
              rows: [],
              rowCount: 0,
              truncated: true,
            });
            return;
          }
        }
        const record = hasArrayMetadata
          ? rawRecord
          : columns.map((column) => rawRecord[column]);
        if (rows.length >= workerData.maxRows) {
          truncated = true;
          break;
        }
        // Avoid base64/JSON expansion for blobs or strings that already cannot fit.
        if (
          record.some(
            (value) =>
              (typeof value === 'string' &&
                Buffer.byteLength(value, 'utf8') > limits.resultBytes) ||
              (value instanceof Uint8Array &&
                value.byteLength > limits.resultBytes / 2),
          )
        ) {
          truncated = true;
          break;
        }
        const row = record.map(scalar);
        const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
        if (bytes + rowBytes > limits.resultBytes) {
          truncated = true;
          break;
        }
        bytes += rowBytes;
        rows.push(row);
      }
      send({ protocol, columns, rows, rowCount: rows.length, truncated });
    }
  } catch {
    // SQL errors may contain local paths, raw data, or supplied parameters. Keep
    // the public error bounded; do not print the database or query to logs.
    process.send({
      ok: false,
      code: 'SQLITE_QUERY_FAILED',
      message:
        'SQLite 查询失败。请检查表名、字段名和参数；数据库仅允许只读查询。',
    });
  } finally {
    database?.close();
  }
});
