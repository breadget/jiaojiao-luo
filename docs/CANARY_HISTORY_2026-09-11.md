# 克隆环境 Canary Runbook

更新：2026-09-11（含本机完整 n8n 启动、真实执行与 `none` 专项结果）　绑定基线标签：站点 `156a672` / 工具链 `2c4b599`（两者都打了 `canary-2026-09-11`，尚未推送标签）

---

## 当前 Canary 状态：**部分通过**，不要当作生产验收

2026-09-11 在本机跑了一轮隔离 Canary。最初把 `127.0.0.1:5679` 上只有
`/healthz` 的进程误认成 n8n 主服务；复核监听端口后确认它其实是 Task Runner
broker。把 broker 从默认的 5679 移到 5680 后，npm 安装的 n8n 2.38.6 主服务、
REST、Webhook 与真实执行全部正常。因此早先“npm 路线不可行”的结论已撤销。

### 已通过（真实 HTTP / 真实 D1，非单元测试）

| 项 | 证据 |
| --- | --- |
| n8n 2.38.6 完整启动 | `127.0.0.1:5679` 的 `/`、`/healthz`、`/rest/settings` 与已发布 `/webhook/*` 均真实可达；Task Runner broker 独立监听 `5680` |
| 站点真实 HTTP 契约 | 正确令牌 → `200 {"ok":true,"bound":true}`；错误令牌 → `401`；缺 `requestId` → `400 BINDING_INVALID` 且零写入；**n8n 内部 workflowId → `404 BINDING_UNKNOWN_WORKFLOW`** |
| 真实提前绑定 | n8n 主执行在危险节点前上报 `execution.bound`；D1 精确落下 `requestId ↔ executionId ↔ wf_n8n_*`，错误内部 workflowId 被 404 拒绝 |
| 无 Key 产品语义 | W1 / W2 / W5 均真实返回 `success=true, mode=rules, degraded=true`；不是“AI 成功” |
| Condition 分流 | W2 经理请求走 true（`slack.addToChannel` 动作意图），普通成员走 false（`directory.updateProfile`） |
| fail-closed | 故意挂错内部令牌后，返回 `BINDING_FAILED`；执行数据只含 Webhook、校验、绑定与 Respond 节点，未进入任何 LLM / Tool / 业务 HTTP 节点 |
| telemetry 游标 | 首次读取拿到 `execution.bound` + 终态事件；以 `nextSeq` 重拉返回 0 条，无重复 |
| 成功执行终态（`all`） | 主 Canary 库 40 条 `success`，`status='running' AND stoppedAt IS NULL` 为 0 |
| `none` 专项 | 在独立复制库同时设置全局和 11 个工作流级 `none`；并发执行分配到 id 46–57 后，`execution_entity` / `execution_data` 均无 46+ 行，永久 running 为 0，2.35.7 故障未在 2.38.6 复现 |
| `n8n audit` | 实际执行 exit 0；收紧后 community packages / version notifications / templates / public API / diagnostics 全为 `false`；剩余为项目所需 Code/HTTP 节点风险清单 |
| 鉴权与 workflowId 拒绝 | 同上（401 / 404 均为实际响应） |
| 迁移 | `0008` **此前从未应用过**，本次应用后 4 个新列齐全；`0007` 三张表在位 |
| 种子与导入 | 5 个 `wf_n8n_*` 行；11 个 workflow + 2 个 httpHeaderAuth 凭据导入且全部发布成功 |

第 4 条那个 404 值得单独记住：如果生成器还像修复前那样写死 n8n 的 id，
**这一条会变成生产事故**（绑定全部失败、5 个工作流一起 `BINDING_FAILED`），
而不是现在这样被明确拒绝。

### 尚未验证（仍阻止 Canary 全通过）

- Graph Adapter 产物中 Memory `sessionKey` 的真实 Agent 执行（当前生成工作流家族不含该 Agent/Memory 图）
- Qwen / DashScope **真实** endpoint：正确 Key、错误 Key、异常格式与超时矩阵（当前没有一次性测试 Key）
- 生产数据克隆后的升级与观察窗口；本轮是隔离本机数据，不等于生产迁移演练
- audit 的过期版本检查因隔离环境无法联网而跳过，需在可联网克隆机重跑该子项
- Graph 发布后的节点级映射与 Studio 实时点亮；当前 11 个生成工作流没有
  `workflow_node_bindings`，所以事件按设计进入 `unmappedNodes`

**因此本 runbook 通过标准仍是 §9 的全部门槛，本轮不算通过。**

> **铁律**：本文所有步骤只允许在**克隆环境**执行。
> 在 canary 全部通过之前：Deploy 保持锁定、不碰生产 n8n、不填真实 Key、
> 不开放公网 n8n API、不设置 `saveDataSuccessExecution=none`。

---

## 0. 前置条件（缺一不可）

| 检查 | 命令 | 期望 |
| --- | --- | --- |
| 两个仓库干净 | `git status --short` | 无输出 |
| 标签就位 | `git rev-parse --short canary-2026-09-11^{commit}` | 站点 `156a672` / 工具链 `2c4b599` |
| 工具链门禁全绿 | 见 §4 | 6 条命令全 exit 0 |
| 独立验收 | `node /tmp/verify-binding.mjs` | `5/5` |
| 站点门禁全绿 | `cd <site> && npm test && npx oxlint` | 全部通过 / 0 错（以当前命令输出为准，不手写易漂移总数） |
| Node 版本 | `node -v` | **≥ 24**（n8n 2.38.6 的 `engines` 就是 `>=24.0.0`，低于它装不起来） |
| **站点 IPv4 可达** | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/state` | `200`（**必须是 127.0.0.1，不是 localhost**） |
| **n8n 健康** | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/healthz` | `200` |
| **n8n REST 已挂载** | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/rest/workflows` | **不是 404**（401/403 都算正常） |
| **webhook 路由已挂载** | `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:<port>/webhook/urtoris/llm-smoke` | **不是 404**（无 Bearer 时应为 403） |

最后两项是本轮踩到的坑：`/healthz` 返回 200 **不代表命中的就是 n8n 主服务**。
若主端口与 Task Runner broker 撞端口，`127.0.0.1` 可能只命中 broker 的 health
路由。必须同时验证 REST 与业务 Webhook；任一 preflight 不通过就停止。

任一不满足就停在这里，不要往下走。

---

## 1. 克隆环境

### ✅ 方案 A：本机 npm 隔离启动（本轮已实测可用）

关键是让主服务端口与 Task Runner broker **不同**：

```bash
export N8N_USER_FOLDER=/tmp/n8n-clone/data
export N8N_PORT=5679
export N8N_RUNNERS_BROKER_PORT=5680
export N8N_PUBLIC_API_DISABLED=true
export N8N_DIAGNOSTICS_ENABLED=false
export N8N_COMMUNITY_PACKAGES_ENABLED=false
export N8N_TEMPLATES_ENABLED=false
export N8N_VERSION_NOTIFICATIONS_ENABLED=false
./node_modules/.bin/n8n start
```

错误现场是：主服务监听 IPv6 的 `:::5679`，broker 监听 IPv4 的
`127.0.0.1:5679`；所以 curl IPv4 时只看见 broker 的 `/healthz`，其他路径全 404。
移动 broker 后，`127.0.0.1:5679/`、`/rest/settings` 与 Webhook 全部正常。

n8n 启动日志仍提示：

> Running n8n outside a container is deprecated. Future versions will require
> running n8n via the official Docker image.

这是“未来版本将要求 Docker”的弃用预告，**不是 2.38.6 当前路由 404 的原因**。
本机 npm 方案适合隔离功能验证；生产同构性仍以官方容器为佳。

### ✅ 方案 B：官方 Docker 镜像（生产同构路线）

```bash
docker run -d --name n8n-canary \
  --network host \
  -e N8N_PORT=5679 \
  -e N8N_RUNNERS_BROKER_PORT=5680 \
  -e N8N_ENCRYPTION_KEY=<固定值，必须与 CLI 一致> \
  -e N8N_SECURE_COOKIE=false \
  -e N8N_PUBLIC_API_DISABLED=true \
  -e N8N_DIAGNOSTICS_ENABLED=false \
  -e N8N_COMMUNITY_PACKAGES_ENABLED=false \
  -e N8N_TEMPLATES_ENABLED=false \
  -e N8N_VERSION_NOTIFICATIONS_ENABLED=false \
  -e EXECUTIONS_DATA_SAVE_ON_SUCCESS=all \
  -e EXECUTIONS_DATA_SAVE_ON_ERROR=all \
  -v /tmp/n8n-canary-data:/home/node/.n8n \
  docker.n8n.io/n8nio/n8n:2.38.6
```

该命令面向隔离 Linux 克隆机。生成器的事件地址**默认**是
`http://127.0.0.1:3000`，所以 Docker bridge 会把 127.0.0.1 解释成容器自己；
要么使用 Linux host networking，要么在生成时用 `URTORIS_EVENTS_URL` 指向真实
宿主地址。macOS Docker 不应照抄这条 host-network 命令。

### ⚠️ 站点必须绑 IPv4：用 `--hostname`，不要用 `--host`

生成的绑定节点默认把事件打到 `http://127.0.0.1:3000/api/n8n/events`
（可在生成时用 `URTORIS_EVENTS_URL` 覆盖）。
实测踩坑：`vinext dev --host 0.0.0.0` 会被**静默忽略**（帮助里只有 `-H, --hostname`），
结果只绑到 IPv6 `[::1]:3000`，IPv4 的 `127.0.0.1` 连接被拒 → 绑定全部失败。

```bash
npx vinext dev --hostname 0.0.0.0 --port 3000   # ✅ 绑 *
npx vinext dev --host 0.0.0.0 --port 3000       # ❌ 被忽略，只绑 IPv6
```

### 持久化与导入顺序

- n8n 的数据目录**必须挂 volume**：否则重建容器后凭据解密的加密密钥与
  已导入数据一起丢失（本机那轮就踩过 `Mismatching encryption keys`——
  server 用随机密钥启动、CLI 又用另一个密钥，直接导致 CLI 全线报错）。
- 顺序固定：**先导入 11 个 workflow + 2 个凭据，再开始真实执行验证**。

---

## 2. 备份

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p /tmp/canary-backup/$STAMP
cp -a /var/lib/urtoris/data        /tmp/canary-backup/$STAMP/d1
cp -a /opt/urtoris/app/.dev.vars   /tmp/canary-backup/$STAMP/ 2>/dev/null || true
cp -a /etc/nginx                   /tmp/canary-backup/$STAMP/ 2>/dev/null || true
cp -a /etc/systemd/system/n8n.service /etc/systemd/system/urtoris.service /tmp/canary-backup/$STAMP/ 2>/dev/null || true
cp -a "$N8N_USER_FOLDER/database.sqlite" /tmp/canary-backup/$STAMP/n8n-clone.sqlite
cp -a /opt/urtoris/app/drizzle     /tmp/canary-backup/$STAMP/drizzle
ls -la /tmp/canary-backup/$STAMP
```

**验收**：能看到 d1 / n8n sqlite / drizzle 三类备份。
**回滚点**：这一份就是全量回滚源，后续任何一步失败都可以回来。

---

## 3. 应用迁移 `0007` / `0008`

```bash
cd <site>
for f in drizzle/0007_workflow_graph.sql drizzle/0008_workflow_graph_publish.sql; do
  npx wrangler d1 execute <DB_NAME> --local --file "$f"
done
```

**两个迁移都是 add-only**：`0007` 建三张新表，`0008` 只给 `workflows` 加一列、给
`workflow_versions` 加三列再加一个索引，**不重写任何已有行**。

**验收**：

```bash
npx wrangler d1 execute <DB_NAME> --local --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workflow_%'"
# 期望：workflow_graph_drafts / workflow_node_bindings / workflow_versions

npx wrangler d1 execute <DB_NAME> --local --command "PRAGMA table_info(workflows)"
# 期望：多出 active_graph_version_id
```

**回滚**：`0008` 加的列可以留着（SQLite 不能直接 DROP COLUMN 老版本，但留着无害，
新代码不读它）；`0007` 的三张表可以 `DROP TABLE`，因为此时还没有任何发布版本。

---

## 4. 部署站点代码与工具链产物

```bash
# 工具链：先生成、再门禁、最后才产出
cd /Users/bird/Documents/机器人
export URTORIS_N8N_INTERNAL_BASE_URL=http://127.0.0.1:5679
export URTORIS_EVENTS_URL=http://127.0.0.1:3000/api/n8n/events
node tools/build-workflows.mjs
node tools/validate-workflows.mjs
node tools/test-node-versions.mjs
node tools/test-execution-binding.mjs
node tools/test-mode-semantics.mjs
node tools/deploy-n8n.mjs --dry-run        # 必须包含 mode/degraded 回归且全绿

# 站点：走安全重建流程（2C/1.6G 上不要在跑着 n8n 时直接 npm run build）
cd <site> && node tools/deploy-urtoris.mjs  # 或克隆机上直接 bash deploy/rebuild-safe.sh
```

⚠️ **端口要点**：默认事件地址是 `http://127.0.0.1:3000/api/n8n/events`；内部网关
默认回调 n8n `127.0.0.1:5678`。克隆端口不同必须在**生成前**设置上面两个变量，
并检查 `generated/manifest.json`。地址错了会导致绑定 `BINDING_FAILED` 或网关
`UPSTREAM_ERROR`，不能靠容器端口映射猜测。

**验收**：站点 `GET /api/state` 返回 200 且带 `Cache-Control: no-store`。

---

## 5. 挂载凭据 + 导入 11 个 workflow（其中 5 个 prebound）

需要两个 Header Auth 凭据（名字必须与产物里的引用一致）：

| 凭据名（n8n credential name） | 用途 |
| --- | --- |
| `Urtoris Internal Token` | 工作流 → 站点 `/api/n8n/events`（值 = `URTORIS_INTERNAL_TOKEN`） |
| `Urtoris Webhook Bearer` | 站点 → 工作流 webhook（值 = `N8N_WEBHOOK_TOKEN`） |

```bash
# 业务工作流是 5 个 prebound；common-*、错误处理器与网关共 6 个 legacy
# 可导入 generated/all-workflows.json，但发布必须先 common-*，再业务，最后网关
for wf in urtoris-wf-llm-smoke urtoris-wf-user-manager urtoris-wf-security-analysis \
          urtoris-wf-api-gateway urtoris-wf-customer-insights; do
  ./node_modules/.bin/n8n import:workflow --input="/path/generated/$wf.json"
done
```

**验收**：导入后 `meta.urtorisBinding` 为 `prebound` 的 5 个工作流，每个都有
`绑定执行 (execution.bound)` → `归一绑定结果` → `绑定成功?` 三个节点，
且 `Webhook` 指向 `校验请求`（不是绑定节点）。

---

## 6. 逐项验证

| # | 验证项 | 怎么验 | 通过判据 |
| --- | --- | --- | --- |
| 1 | `execution.bound` | 正常发一次请求，查 `n8n_events` | 第一条节点事件就是 `execution.bound` |
| 2 | requestId ↔ executionId | `SELECT * FROM n8n_execution_map WHERE request_id=?` | 有且只有一条，`workflow_id` 是**站点** id（`wf_n8n_*`） |
| 3 | 重放 / 多 execution 方向 | ① 对外 API 用同 requestId 重发已落库的成功或失败 run；② 直接向绑定入口上报同 requestId + 新 executionId；③ 同 executionId + 新 requestId | ① `replayed=true`、同一 run/execution、n8n 不新增执行；② 200 且两条映射并存；③ 409 且旧绑定不变 |
| 4 | Memory sessionKey | 看 `绑定成功?` 之后的 Agent 分支、查 Memory 节点执行数据 | `sessionKey` 取到真实 `sessionId`（不是 undefined/空） |
| 5 | Qwen endpoint | Agent + Chat Model 路径 | 请求打到 DashScope 兼容端点，`responsesApiEnabled` 已关（1.3 默认 true 会踩坑） |
| 6 | Condition 分支 | 造 high / 非 high 两个请求 | true/false 真的走不同分支（`options.version` 与 typeVersion 2.2 配套） |
| 7 | 失败不进入危险节点 | 故意停掉站点或填错内部令牌 | 返回 `BINDING_FAILED`，**看不到**任何 LLM/HTTP/Tool 节点执行 |
| 8 | telemetry + 断线重连 | 轮询 `/api/runs/:requestId/telemetry?afterSeq=` | 记下 `nextSeq`，隔几秒再拉只返回新事件；不重复不丢 |

第 7 项是最关键的一条：**它是整个 fail-closed 设计的实证**。做法是先把
`URTORIS_INTERNAL_TOKEN` 改错让绑定必然失败，确认工作流在
`绑定成功?` 就分到 `Respond to Webhook`，n8n 执行记录里**没有** Agent/Tool/HTTP 节点。

本机 2026-09-11 已真实通过 #1、#2、#6、#7、#8；#3 的公开重放与绑定方向
分别由真实请求和自动化测试覆盖。#4、#5 仍未通过，故 §6 整体仍是未完成。

---

## 7. `saveDataSuccessExecution` 专项确认

背景：生产基线 n8n 2.35.7 在 `saveDataSuccessExecution='none'` 时曾不更新
`execution_entity` 终态，造成 100+ 条永久 `running`。2026-09-11 在完全隔离的
n8n 2.38.6 上做了两层验证：

- `all`：主 Canary 库 40 条成功执行全部定稿，永久 running 为 0；
- `none`：复制数据库后，**同时**把全局变量和 11 个工作流级
  `saveDataSuccessExecution` 改为 `none`。三条真实请求并发执行，执行 id 从 46
  分配到 57；完成后 `execution_entity` 与 `execution_data` 均无 46+ 行，永久
  running 为 0。

所以该故障在 2.38.6 本机样本中**未复现**。这不授权直接改生产：生产升级仍需
用生产数据克隆再跑一次，并保留观察窗口与回滚点。

```bash
grep -E 'EXECUTIONS_DATA_SAVE' /tmp/n8n.env || echo "未设置（默认 all）"
# 观察窗口内反复检查有没有永久 running
sqlite3 "$N8N_USER_FOLDER/database.sqlite" \
  "SELECT status, COUNT(*) FROM execution_entity GROUP BY status;"
# 跑完若干次请求后，再查一次：running 应该回归 0
sqlite3 "$N8N_USER_FOLDER/database.sqlite" \
  "SELECT COUNT(*) FROM execution_entity WHERE status='running' AND stoppedAt IS NULL;"
```

**通过判据**：`all` 模式观察窗口结束后永久 running 为 0；隔离 `none` 模式下，
成功执行可以被完整删除或定稿，但绝不能留下 running 行。只改全局变量不够——
工作流自身的 `settings.saveDataSuccessExecution='all'` 会覆盖它。

---

## 8. `n8n audit`

```bash
N8N_DIAGNOSTICS_ENABLED=false \
N8N_PUBLIC_API_DISABLED=true \
N8N_COMMUNITY_PACKAGES_ENABLED=false \
N8N_TEMPLATES_ENABLED=false \
N8N_VERSION_NOTIFICATIONS_ENABLED=false \
./node_modules/.bin/n8n audit
```

**通过判据**：实例五项功能开关都为 `false`；所有 Code / HTTP 风险节点逐项属于
已知生成产物，不出现 `executeCommand` 或未知社区节点；凭据使用彼此独立的令牌。
本机 audit 已满足这些条件。其版本过期报告因隔离网络无法抓取版本列表而跳过，
需在可联网克隆机补跑，不能把“跳过”写成通过。

---

## 9. 生产灰度门槛

以下**全部**满足才可谈生产：

- [ ] §6 八项全过（尤其第 7 项 fail-closed 实证）
- [x] §7 本机 2.38.6 的 `all` 与隔离 `none` 样本均无永久 `running`
- [ ] §8 audit 安全配置与节点清单已审；联网版本检查仍待克隆机补跑
- [ ] 5 个 prebound 工作流在克隆环境连续跑通，`unmappedNodes` 符合预期
      （非 Graph 发布的工作流本来就没有绑定行，未映射是**正常状态**）
- [ ] 生产备份完成且可用
- [ ] 回滚演练过：指针回滚 + 迁移回滚 + n8n 回滚各一次

**在此之前**：Deploy 锁定、不碰生产 n8n、不填真实 Key、不开放公网 n8n API、
不设置 `saveDataSuccessExecution=none`。

---

## 附：本 runbook 覆盖不到的部分

- **克隆 ECS 的供给**（新机器、DNS、nginx）是基础设施动作，需要人来开机器。
  本机 npm 方案可继续覆盖功能验证，但不能替代生产数据克隆与网络同构演练。
- **Qwen / DashScope 真实调用**需要一把测试 Key。**不要**把生产 Key 填进 Graph
  或任何提交物；只在克隆环境的 n8n 凭据里临时挂载，验证完即撤。
- 硬件（ESP32）与机器人模拟器不在本 runbook 范围。
