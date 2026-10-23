-- 确定性 requestId ↔ executionId 映射，以及执行模式语义。

ALTER TABLE runs ADD COLUMN mode TEXT;
ALTER TABLE runs ADD COLUMN degraded INTEGER DEFAULT 0 NOT NULL;

CREATE TABLE IF NOT EXISTS n8n_execution_map (
  execution_id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_n8n_execution_map_request_id
  ON n8n_execution_map (request_id);
CREATE INDEX IF NOT EXISTS idx_n8n_execution_map_workflow_id
  ON n8n_execution_map (workflow_id);
