# ECS 部署材料

本目录包含把当前工作流站点部署到 `urtoris.cn` 的服务配置。应用本身使用 Wrangler 的本地 Worker 运行时，绑定在 `127.0.0.1:3000`，由现有 Nginx 负责 HTTPS 和域名入口。

部署时需要在 ECS 上完成以下动作：

1. 安装 Node.js 22，并在应用目录执行 `npm ci`、`npm run build`。
2. 创建 `urtoris` 系统用户、`/opt/urtoris/app`、`/var/lib/urtoris/data` 和 `/var/log/urtoris`。
3. 在 `/opt/urtoris/app/.dev.vars` 写入 `URTORIS_API_TOKEN`、独立的 `URTORIS_ADMIN_TOKEN`、`N8N_BASE_URL` 和（如启用 n8n 鉴权）`N8N_WEBHOOK_TOKEN`，权限设为 `600`。管理令牌不要与 API 令牌复用。
4. 将构建后的 Drizzle 迁移放到 `dist/server/migrations`，清理 macOS `._*` 元数据，并初始化本地 D1 数据库。
5. 将 `urtoris.service` 安装到 `/etc/systemd/system/` 并启动；服务会从 `.dev.vars` 读取 API 密钥，并把 D1 数据保存到 `/var/lib/urtoris/data`。
6. 备份现有 `/etc/nginx/sites-available/urtoris.cn`，用 `urtoris.nginx.conf` 替换站点配置，检查后重载 Nginx。
7. 使用 `Authorization: Bearer <URTORIS_ADMIN_TOKEN>` 调用 `/api/workflows` 创建 `seed-workflow.json` 中的示例工作流，再用 `/api/v1/run` 做一次 `URTORIS_API_TOKEN` Bearer 密钥测试。

不要把 `.dev.vars` 或 API 密钥打进部署压缩包；它们应只在 ECS 上生成和保存。

n8n 正式 HTTPS、独立运行用户和工作流可观测更新位于 [`deploy/n8n/`](n8n/)。协议与运维约定见 [`docs/PROTOCOL-v1.md`](../docs/PROTOCOL-v1.md) 和 [`docs/OPERATIONS.md`](../docs/OPERATIONS.md)。
