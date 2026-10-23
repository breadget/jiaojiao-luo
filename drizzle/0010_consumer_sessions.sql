-- 使用端持久化：每个浏览器 / 工作流独立的对话、消息与 Python 运行台账。
-- 浏览器的原始随机 token 仅在 HttpOnly cookie 中，库内只存 SHA-256。

CREATE TABLE IF NOT EXISTS consumer_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  browser_key_hash TEXT NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  engine_session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_consumer_sessions_browser_workflow
  ON consumer_sessions(browser_key_hash, workflow_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_consumer_sessions_updated_at
  ON consumer_sessions(updated_at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS consumer_messages (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES consumer_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'agent')),
  status TEXT NOT NULL CHECK(status IN ('working', 'completed', 'failed')),
  text TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_consumer_messages_session_created
  ON consumer_messages(session_id, created_at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS consumer_python_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES consumer_sessions(id) ON DELETE CASCADE,
  agent_message_id TEXT REFERENCES consumer_messages(id) ON DELETE SET NULL,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  profile TEXT NOT NULL CHECK(profile IN ('short', 'long')),
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  limits_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_consumer_python_runs_session_created
  ON consumer_python_runs(session_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_consumer_python_runs_task
  ON consumer_python_runs(task_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_consumer_python_runs_status
  ON consumer_python_runs(status);
