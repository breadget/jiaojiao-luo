# Urtoris 运维要点

## 正式入口

- 网站：`https://urtoris.cn`
- n8n 编辑器和 Webhook（备案及边缘放行后）：`https://n8n.urtoris.cn`
- Nginx 反向代理：n8n 仅监听 `127.0.0.1:5678`

n8n 必须配置 `N8N_EDITOR_BASE_URL` 和 `WEBHOOK_URL` 为正式 HTTPS 子域名，并设置 `N8N_PROXY_HOPS=1`。但在中国内地边缘仍按 SNI 拦截该未放行域名时，签发或安装证书本身不能恢复公网访问；正式切换前必须先完成备案/边缘放行或迁到不受该策略影响的入口。不使用 IP、隧道或临时地址注册长期 Webhook 和 OAuth 回调。

## 发布顺序

1. 备份站点源码、D1 持久化目录、n8n 数据目录、Nginx 和 systemd 配置。
2. 先在本地跑站点构建和协议校验。
3. 在 ECS 上用 `deploy/rebuild-safe.sh` 构建；低内存机器构建期间会暂停 n8n。
4. 应用 D1 迁移后重启站点，再恢复 n8n。
5. 验证五个绑定、两个并发请求的 requestId/executionId、规则降级语义和错误归一。

`/healthz` 返回 200 只代表 n8n 已监听端口，不代表 active workflows 已全部注册。重启后的自动测试必须等到 `/healthz/readiness` 通过，并且对 W1 Webhook 的无凭据探测返回 401/403（而不是未注册时的 404）后再开始。

## 执行数据

当前 n8n 2.35.7 暂时保留成功和失败执行，并以 72 小时、最多 2000 条自动 pruning 控制 SQLite 体积：

```ini
EXECUTIONS_DATA_SAVE_ON_ERROR=all
EXECUTIONS_DATA_SAVE_ON_SUCCESS=all
EXECUTIONS_DATA_SAVE_ON_PROGRESS=false
EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS=false
EXECUTIONS_DATA_PRUNE=true
EXECUTIONS_DATA_MAX_AGE=72
EXECUTIONS_DATA_PRUNE_MAX_COUNT=2000
```

原因：本实例已复现 `EXECUTIONS_DATA_SAVE_ON_SUCCESS=none` 可能让成功执行的 `execution_entity` 一直停在 `running`。在升级版本通过下方定稿验收前，不得重新设为 `none`。

判断“僵尸执行”必须以长时间未结束的 `status='running'` 为准，不能只看 `finished=0`。历史错误执行可以合法表现为 `status='error'`、`finished=0` 且 `stoppedAt` 已填写，不得批量改写。

每次修改保存策略或升级 n8n 后，至少连续发起 3 次无副作用的 W1 请求，并用返回的精确 `executionId` 验证：

```sql
SELECT id, status, finished, "startedAt", "stoppedAt", "waitTill"
FROM execution_entity
WHERE id IN (?, ?, ?);
```

三个目标行必须全部满足 `status='success'`、`finished=1`、`stoppedAt IS NOT NULL`。同时检查真正的陈旧运行项：

```sql
SELECT id, "workflowId", "startedAt", "waitTill"
FROM execution_entity
WHERE status='running'
  AND "startedAt" < datetime('now', '-10 minutes');
```

只有排除等待型工作流、确认对应进程不再运行并完成数据库备份后，才允许逐条修复陈旧行。网站 `runs`、`n8n_events` 和 `n8n_execution_map` 仍是业务审计与确定性关联的主记录。

## 安全审计

每次修改 Webhook、凭据、社区节点或实例安全配置后运行：

```bash
set -a
source /opt/n8n/.env
set +a
n8n audit
```

直接从 shell 执行 CLI 不会自动继承 systemd 的 `EnvironmentFile`，因此必须先导入同一份环境；否则审计会把已关闭的功能误报为默认启用。审计报告是风险清单，不是自动修复器。未保护 Webhook、危险节点、未使用凭据和缺失安全设置必须逐项判断，不可为了“清零”删除比赛所需能力。

生产实例不使用 n8n Public API 或社区节点，应保持：

```ini
N8N_PUBLIC_API_DISABLED=true
N8N_PUBLIC_API_SWAGGERUI_DISABLED=true
N8N_COMMUNITY_PACKAGES_ENABLED=false
N8N_TEMPLATES_ENABLED=false
N8N_DIAGNOSTICS_ENABLED=false
```

Code 与 HTTP Request 是比赛工作流的必要能力，`n8n audit` 会按节点类型列为风险；处理方式是逐个审查输入、目标 URL、鉴权和超时，而不是全局禁用。

## 网站 API 边界

公网 `GET /api/state` 当前用于工作台加载数据，返回专用的公开 DTO：不包含 n8n 鉴权头；运行记录去除消息原文、内部日志、session/request/execution 关联标识等非展示必需字段。为支持工作台配置和编辑，工作流 DTO 仍会返回已保存的 `n8nWebhookUrl`；该 URL 不包含鉴权令牌，并且服务端在保存和执行前都会再次校验其是否属于 `N8N_BASE_URL` origin 下的 `/webhook/urtoris/*` 白名单。若后续不再需要浏览器编辑，可进一步改为仅返回脱敏的 origin/路径状态。

`POST /api/workflows` 是管理面，要求 `Authorization: Bearer <URTORIS_ADMIN_TOKEN>`（也接受 `X-Urtoris-Admin-Token`），并有每 IP 60 秒 30 次限制、64 KB 请求体上限。部署时必须在 `.dev.vars` 配置独立的 `URTORIS_ADMIN_TOKEN`，不能复用 `URTORIS_API_TOKEN`。

### 本机 / 内网访问免令牌（2026-09-12 起）

管理面还有一条便捷通道：**当请求的访问入口本身是本机或私网**（`localhost` / `127.0.0.0/8` /
`10.0.0.0/8` / `172.16.0.0/12` / `192.168.0.0/16` / `169.254.0.0/16` / IPv6 唯一本地地址 / `.local`，
且 `Sec-Fetch-Site` 不是 `cross-site`）时，服务端直接把这次会话当成管理员，
本地开发不用再往页面里粘令牌。判定顺序：

1. 令牌正确 → 放行（公网入口走这条）；
2. 否则是「本机 / 内网且未经代理」→ 放行；
3. 否则没配令牌 → 503，配了但不对 → 401。

防伪装的关键点是**代理头**：公网 nginx 一定会写 `X-Forwarded-For` / `X-Real-IP`
（见 `deploy/urtoris.nginx.conf`），所以远程访客把 `Host` 伪造成 `localhost` 也没用 ——
只要代理链上出现非私网地址就不算自己人。生产上要彻底关掉这条通道：

```bash
# .dev.vars / 生产环境变量
URTORIS_ADMIN_TRUST_LOCAL=0
```

回归测试见 `tests/admin-trust.test.ts`（本机放行、公网要令牌、Host 伪装被拒、跨站被拒、开关可关）。

`POST /api/runs` 与 `POST /api/agent/chat` 是执行面：浏览器请求必须同源，服务端/CLI 请求必须携带 `Authorization: Bearer <URTORIS_API_TOKEN>`；每 IP 每 60 秒分别限制 20 次和 12 次，请求体上限 32 KB。跨站请求会返回 403，超限返回 429 和 `Retry-After`。

工作流的 n8n 地址只能是 `N8N_BASE_URL` 的 origin 下 `/webhook/urtoris/*` 路径；站点统一使用服务端 `N8N_WEBHOOK_TOKEN`，迁移 `0006_security_guardrails` 会删除历史 `n8n_auth_header` 列。任何 URL 解析失败或目标超出白名单都会返回 400，且不会触发 n8n。
