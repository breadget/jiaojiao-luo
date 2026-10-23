CREATE TABLE IF NOT EXISTS n8n_runtime_streams (
  execution_id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  version_id TEXT NOT NULL REFERENCES workflow_versions(id),
  session_id TEXT,
  last_source_seq INTEGER NOT NULL DEFAULT -1,
  terminal_type TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS n8n_runtime_streams_request ON n8n_runtime_streams(request_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS n8n_runtime_receipts (
  execution_id TEXT NOT NULL REFERENCES n8n_runtime_streams(execution_id),
  source_seq INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  event_hash TEXT NOT NULL,
  PRIMARY KEY (execution_id, source_seq)
);
