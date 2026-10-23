-- 幂等：同一个 requestId 只允许一条运行记录。
--
-- 语义（与 /api/agent/chat、/api/runs、/api/v1/run 三个入口一致）：
--   · 重复投递同一个 requestId，且工作流相同  → 直接返回已记录的那次运行（replayed: true），不再执行
--   · 同一个 requestId 换了一个工作流         → 409，视为调用方串了 ID
--   · request_id 为 NULL 的历史记录不受约束（SQLite 的部分唯一索引允许多个 NULL）
--
-- 旧的非唯一索引在 0002 里建的，这里换成唯一的部分索引，避免留两个同义索引。

DROP INDEX IF EXISTS idx_runs_request_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_request_id_unique
  ON runs (request_id)
  WHERE request_id IS NOT NULL;
