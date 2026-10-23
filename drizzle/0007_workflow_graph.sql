-- Workflow Studio add-only persistence. Existing WorkflowStep[] and n8n bindings
-- remain untouched until the adapter path has passed production canaries.

CREATE TABLE IF NOT EXISTS workflow_graph_drafts (
  workflow_id TEXT PRIMARY KEY NOT NULL,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  graph_json TEXT NOT NULL,
  graph_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON UPDATE NO ACTION ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_graph_drafts_updated_at
  ON workflow_graph_drafts (updated_at);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id TEXT PRIMARY KEY NOT NULL,
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  graph_json TEXT NOT NULL,
  graph_hash TEXT NOT NULL,
  adapter TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  compiled_json TEXT,
  compiled_hash TEXT,
  external_workflow_id TEXT,
  webhook_path TEXT,
  published_at INTEGER NOT NULL,
  published_by TEXT,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON UPDATE NO ACTION ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_versions_workflow_version
  ON workflow_versions (workflow_id, version);

CREATE TABLE IF NOT EXISTS workflow_node_bindings (
  workflow_version_id TEXT NOT NULL,
  internal_node_id TEXT NOT NULL,
  external_node_id TEXT NOT NULL,
  external_node_name TEXT,
  role TEXT NOT NULL DEFAULT 'primary',
  PRIMARY KEY (workflow_version_id, internal_node_id, external_node_id),
  FOREIGN KEY (workflow_version_id) REFERENCES workflow_versions(id) ON UPDATE NO ACTION ON DELETE CASCADE
);
