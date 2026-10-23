-- 工作流管理列表需要“删除”，但运行、会话和发布快照属于审计历史，
-- 不应因为一次界面操作被物理清空。deleted_at 让工作流从所有活动入口隐藏，
-- 同时保留数据，后续可以安全补上恢复能力。

ALTER TABLE workflows ADD COLUMN deleted_at INTEGER;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_workflows_active_updated_at
  ON workflows (deleted_at, updated_at DESC);
