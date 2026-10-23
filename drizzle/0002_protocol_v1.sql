-- 协议 v1：全链路可观测字段 + n8n 执行事件表
-- 幂等：全部使用 IF NOT EXISTS / 由 wrangler d1 migrations 记录版本，只应用一次。

ALTER TABLE runs ADD COLUMN request_id TEXT;
ALTER TABLE runs ADD COLUMN session_id TEXT;
ALTER TABLE runs ADD COLUMN engine TEXT;
ALTER TABLE runs ADD COLUMN error_code TEXT;
ALTER TABLE runs ADD COLUMN error_message TEXT;
ALTER TABLE runs ADD COLUMN duration_ms INTEGER;
ALTER TABLE runs ADD COLUMN attempts INTEGER;
ALTER TABLE runs ADD COLUMN execution_id TEXT;

CREATE INDEX IF NOT EXISTS idx_runs_request_id ON runs (request_id);
CREATE INDEX IF NOT EXISTS idx_runs_session_id ON runs (session_id);

CREATE TABLE IF NOT EXISTS n8n_events (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT,
  session_id TEXT,
  workflow TEXT,
  execution_id TEXT,
  level TEXT DEFAULT 'info' NOT NULL,
  event_type TEXT DEFAULT 'log' NOT NULL,
  node TEXT,
  message TEXT DEFAULT '' NOT NULL,
  payload_json TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_n8n_events_request_id ON n8n_events (request_id);
CREATE INDEX IF NOT EXISTS idx_n8n_events_created_at ON n8n_events (created_at);
