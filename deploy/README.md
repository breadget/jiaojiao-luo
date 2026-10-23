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

## 画布程序后台服务

首次启用前，由 root 从**已审查的新源码目录**执行以下准备；即使生产目录仍是没有
program worker 的旧版本也可以执行。准备脚本保留既有站点设置和任务文件，生成或
复用内部令牌，将同一令牌写入站点 `.dev.vars` 与 worker 私有环境文件，不打印令牌，
不启动或重启网站及 worker。两处已存在的令牌若不一致会停止准备，避免意外轮换。

```bash
sudo python3 deploy/setup-workflow-program.py
sudo install -o root -g root -m 0755 deploy/github-actions/urtoris-runtime-deploy /usr/local/sbin/urtoris-runtime-deploy
```

准备后应具备：

- `urtoris-program` 系统用户，主组为 `urtoris`；已有 `urtoris` 应用用户和 Node.js ≥22.13。
- `/var/lib/urtoris-workflow-program`：`urtoris-program:urtoris`、`0700`，位于发布目录之外。
- `/etc/urtoris/workflow-program.env`：`root:urtoris`、`0640`，保存内部 `WORKFLOW_PROGRAM_TOKEN`、固定端口和状态目录；浏览器的模型 Key 不写入这里。
- 站点 `.dev.vars`：`urtoris:urtoris`、`0600`，增加相同的 `WORKFLOW_PROGRAM_TOKEN` 和 `WORKFLOW_PROGRAM_URL=http://127.0.0.1:8030`。
- `urtoris-workflow-program.service` 已安装并 enabled。旧版本没有 worker 入口时，`ConditionPathExists` 会跳过启动；下次运行时部署负责启动并验证服务。

worker 只监听 `127.0.0.1:8030`，无需开放安全组端口或修改 Nginx。它直接使用课程
服务的 `127.0.0.1:8001` 检索入口，不需要重装 Django 环境。生产运行时包必须包含
worker 与 `lib/workflow-program`、画布编译器、共用模型客户端、`tsconfig.json` 和
`node_modules/tsx`；CI 会在生产 Node 22 下验证入口可导入，服务器也会在停止服务前
再次验证依赖、私有配置和状态目录权限。

部署先完成 D1 迁移，再停止 worker、备份并准备课程状态，然后原子切换整个应用
目录。课程服务就绪后启动 worker，检查 `/health` 返回预期服务标识；worker 健康
失败或后续步骤失败会恢复旧应用与课程状态，并恢复 worker 原先的运行状态。
任务记录和产物不随代码回滚；重启发现的 queued/running 任务会以 `WORKER_RESTARTED`
结束，不能自动重跑。首次部署前原本未运行的 worker 在回滚后继续保持停止。

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
