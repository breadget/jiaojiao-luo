/** JSON contract for reading an explicitly selected SQLite file on this computer. */
export const LOCAL_DATABASE_PROTOCOL = 'urtoris.local-database.v1';

export const LOCAL_DATABASE_LIMITS = {
  filePathCharacters: 4_096,
  sqlCharacters: 16_000,
  parameterCount: 100,
  parameterStringCharacters: 8_192,
  requestBytes: 128 * 1_024,
  defaultRows: 100,
  maximumRows: 500,
  resultBytes: 32 * 1_024,
  schemaTables: 50,
  schemaColumns: 100,
  defaultTimeoutMs: 5_000,
  maximumTimeoutMs: 10_000,
} as const;

export type LocalDatabaseErrorCode =
  | 'INVALID_REQUEST'
  | 'DATABASE_FILE_NOT_FOUND'
  | 'DATABASE_FILE_UNAVAILABLE'
  | 'INVALID_SQLITE_FILE'
  | 'READ_ONLY_QUERY_REQUIRED'
  | 'SQLITE_QUERY_FAILED'
  | 'DATABASE_QUERY_TIMEOUT'
  | 'DATABASE_RUNTIME_UNAVAILABLE';

export type LocalDatabaseParameter = string | number | null;
export type LocalDatabaseParameters =
  | LocalDatabaseParameter[]
  | Record<string, LocalDatabaseParameter>;

/** Large integers and binary values retain their type without losing precision. */
export type LocalDatabaseValue =
  | string
  | number
  | null
  | { type: 'integer'; value: string }
  | { type: 'blob'; base64: string; bytes: number };

export type LocalDatabaseColumn = {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
};

export type LocalDatabaseTable = {
  name: string;
  kind: 'table' | 'view';
  columns: LocalDatabaseColumn[];
  truncated: boolean;
};

export type LocalDatabaseSchema = {
  protocol: typeof LOCAL_DATABASE_PROTOCOL;
  filePath: string;
  tables: LocalDatabaseTable[];
  truncated: boolean;
};

export type LocalDatabaseQueryRequest = {
  filePath: string;
  sql: string;
  parameters?: LocalDatabaseParameters;
  maxRows?: number;
  timeoutMs?: number;
};

export type LocalDatabaseQueryResult = {
  protocol: typeof LOCAL_DATABASE_PROTOCOL;
  columns: string[];
  rows: LocalDatabaseValue[][];
  rowCount: number;
  truncated: boolean;
};
