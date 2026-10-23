-- 管理面和执行面安全边界由运行时环境变量控制；此迁移清理历史显式鉴权头。
-- 网站统一使用 N8N_WEBHOOK_TOKEN，数据库不再保存可被管理面回显的令牌。
-- 0001 在旧实例上创建该列；保留 DROP 兼容 SQLite/D1 的历史表结构。
ALTER TABLE workflows DROP COLUMN n8n_auth_header;
