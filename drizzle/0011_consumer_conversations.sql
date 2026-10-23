-- 使用端从「每个工作流一条长期会话」升级为真正的多会话聊天记录。
-- 旧会话保留，有历史消息时从首条用户请求回填标题；
-- 新会话由首轮对话自动命名。

ALTER TABLE consumer_sessions ADD COLUMN title TEXT NOT NULL DEFAULT '新对话';
--> statement-breakpoint
DROP INDEX IF EXISTS idx_consumer_sessions_browser_workflow;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_consumer_sessions_browser_workflow_updated
  ON consumer_sessions(browser_key_hash, workflow_id, updated_at DESC);
--> statement-breakpoint
UPDATE consumer_sessions
SET title = substr(
  (
    SELECT trim(replace(replace(message.text, char(10), ' '), char(13), ' '))
    FROM consumer_messages AS message
    WHERE message.session_id = consumer_sessions.id
      AND message.role = 'user'
      AND trim(message.text) <> ''
    ORDER BY message.created_at ASC, message.id ASC
    LIMIT 1
  ),
  1,
  18
)
WHERE title = '新对话'
  AND EXISTS (
    SELECT 1
    FROM consumer_messages AS message
    WHERE message.session_id = consumer_sessions.id
      AND message.role = 'user'
      AND trim(message.text) <> ''
  );
