-- 执行占位（claim）：把"幂等"从"记录去重"提升到"副作用去重"。
--
-- 没有这张表时，两个并发的同 requestId 请求都会通过前置检查、都去执行 n8n，
-- 事后虽然只有一条 runs 记录（唯一索引兜住），但**工作流已经跑了两遍**。
-- 对"建用户"这类有副作用的流程，这正是最危险的失败模式。
--
-- 语义：
--   · 抢到 claim 的请求才允许真正触发 n8n
--   · 没抢到的请求轮询等结果；等到了就重放，等不到返回 409（而不是重复执行）
--   · claim 有 TTL，超时视为陈旧并允许接管，避免进程崩溃后 requestId 永久卡死
--   · request_id 为 NULL（未指定）时不参与 claim

CREATE TABLE IF NOT EXISTS run_claims (
  request_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_claims_claimed_at ON run_claims (claimed_at);
