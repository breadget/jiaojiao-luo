CREATE TABLE workflow_program_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  version_id TEXT NOT NULL REFERENCES workflow_versions(id),
  consumer_session_id TEXT NOT NULL REFERENCES consumer_sessions(id),
  request_id TEXT NOT NULL UNIQUE,
  input_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_program_jobs_session_created
ON workflow_program_jobs(consumer_session_id, created_at);
