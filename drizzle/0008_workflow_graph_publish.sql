-- Workflow Studio 不可变发布。
--
-- 0007 建了 workflow_versions / workflow_node_bindings 两张表，但那时还没有
-- "当前生效的是哪个版本" 这个概念，回滚无从下手。这里补三件事：
--   1. workflows.active_graph_version_id：发布指针（回滚就是改这一个字段）；
--   2. workflow_versions 的审计与列表列（graph_revision / node_count / connection_count），
--      这样版本列表不必把每份 graph_json 都读出来。
--
-- 注意：workflow_versions 写入之后不允许 UPDATE 业务字段。它只增不改，
-- 回滚通过移动指针实现，所以"已发布版本不可被覆盖"是结构上的保证。

ALTER TABLE workflows ADD COLUMN active_graph_version_id TEXT;

CREATE INDEX IF NOT EXISTS idx_workflows_active_graph_version
  ON workflows (active_graph_version_id);

ALTER TABLE workflow_versions ADD COLUMN graph_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE workflow_versions ADD COLUMN node_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE workflow_versions ADD COLUMN connection_count INTEGER NOT NULL DEFAULT 0;
