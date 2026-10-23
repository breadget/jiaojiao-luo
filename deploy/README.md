# ECS 部署材料

本目录包含把当前工作流站点部署到 `urtoris.cn` 的服务配置。应用本身使用 Wrangler 的本地 Worker 运行时，绑定在 `127.0.0.1:3000`，由现有 Nginx 负责 HTTPS 和域名入口。

部署时需要在 ECS 上完成以下动作：

1. 安装 Node.js 22，并在应用目录执行 `npm ci`、`npm run build`。
2. 创建 `urtoris` 系统用户、`/opt/urtoris/app`、`/var/lib/urtoris/data` 和 `/var/log/urtoris`。
3. 在 `/opt/urtoris/app/.dev.vars` 写入 `URTORIS_API_TOKEN`、独立的 `URTORIS_ADMIN_TOKEN`、`N8N_BASE_URL` 和（如启用 n8n 鉴权）`N8N_WEBHOOK_TOKEN`，权限设为 `600`。管理令牌不要与 API 令牌复用。
4. 将构建后的 Drizzle 迁移放到 `dist/server/migrations`，清理 macOS `._*` 元数据，并初始化本地 D1 数据库。
5. 将 `urtoris.service` 安装到 `/etc/systemd/system/` 并启动；服务会从 `.dev.vars` 读取 API 密钥，并把 D1 数据保存到 `/var/lib/urtoris/data`。
6. 备份现有 Nginx 配置，同时安装 `nginx/urtoris-protection.conf` 与三个 `nginx/urtoris-*.conf` snippet，再安装 `urtoris.nginx.conf`，检查后重载 Nginx。当前阿里云生产机使用下方的防护安装器。
7. 使用 `Authorization: Bearer <URTORIS_ADMIN_TOKEN>` 调用 `/api/workflows` 创建 `seed-workflow.json` 中的示例工作流，再用 `/api/v1/run` 做一次 `URTORIS_API_TOKEN` Bearer 密钥测试。

不要把 `.dev.vars` 或 API 密钥打进部署压缩包；它们应只在 ECS 上生成和保存。

## 课程助教服务

生产使用 `urtoris-course-assistant.service`：单 Gunicorn worker、2 个线程，绑定 `127.0.0.1:8001`，由主站同源接口访问。Python 虚拟环境安装在 `/opt/urtoris/course-runtime/venv`，依赖来自 `course-assistant/requirements.txt`；服务读取 `/etc/urtoris-course.env`（`root:urtoris`、640），其中设置 `DJANGO_DEBUG=false`、独立的 `DJANGO_SECRET_KEY` 和本机 `DJANGO_ALLOWED_HOSTS`。聊天密钥仅在确实需要模型回答时配置。

持久化数据目录 `/var/lib/urtoris-course`（`urtoris:urtoris`、750）由 `COURSE_ASSISTANT_STATE_DIR` 指定，保存 SQLite 问答记录、FAISS 索引和向量模型缓存。首次发布先准备模型和索引，避免线上首次提问下载模型。主站服务器的 `.dev.vars` 设置 `COURSE_ASSISTANT_PUBLIC_ORIGIN=https://urtoris.cn`，只开放课程状态/提问入口，管理、机器人及本机控制的授权规则保持原有边界。

受限部署脚本在网站切换前执行课程迁移和索引检查，切换后重启课程服务并检查知识库就绪状态；部署失败时恢复网站和课程服务。Python 依赖变动需先更新独立虚拟环境，依赖与课程记录不进入网站运行时包。

n8n 正式 HTTPS、独立运行用户和工作流可观测更新位于 [`deploy/n8n/`](n8n/)。协议与运维约定见 [`docs/PROTOCOL-v1.md`](../docs/PROTOCOL-v1.md) 和 [`docs/OPERATIONS.md`](../docs/OPERATIONS.md)。

## 网站入口防护

当前生产布局（`urtoris.cn`、`n8n`、`n8n-ip` 三个 enabled site）使用：

```bash
sudo python3 deploy/apply-site-protection.py --check-only
sudo python3 deploy/apply-site-protection.py
```

安装器先在 `127.0.0.1:18080/18443` 启动独立 Nginx，验证域名路由、扫描拦截、
代理头清理、跨站拒绝、限流、静态资源及上传限额，然后备份生产配置、安装、
执行 `nginx -t` 并重载。网站的生产 `URTORIS_ADMIN_TRUST_LOCAL` 同时设为 `0`，
管理操作要求独立管理员令牌；验证失败自动恢复配置和网站环境。

默认 IP/未知 Host 入口关闭；网站仍通过正式 HTTPS 域名访问。n8n 编辑器和 REST
管理接口只允许本机，管理时使用 SSH：

```bash
ssh -i ~/.ssh/urtoris-ecs -L 15678:127.0.0.1:5678 root@8.133.252.143
# 浏览器打开 http://localhost:15678
```

公网 `/webhook/urtoris/*` 保留原有 n8n Header Auth，并增加限流及 128 KiB 体积上限；
网站调用 n8n 使用 loopback，不经过公网入口。n8n 域名完成 HTTPS 放行前不注册新的
长期公网 Webhook/OAuth 回调。
