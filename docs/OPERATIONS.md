# Urtoris n8n 运维手册

面向"比赛现场只有你一个人、服务器只有 2C/1.6G"这个前提写的。每一节都是可以直接复制执行的命令。

---

## 1. 这套东西现在长什么样

```
浏览器 / 外部程序
      │  ① 网站统一入口（BYO Key 随请求透传）
      ▼
Urtoris (wrangler dev @ 127.0.0.1:3000)
      │  ② v1 协议信封 + Bearer 令牌 + requestId/sessionId
      ▼
n8n (127.0.0.1:5678)
      │
      ├─ urtoris-gateway        统一入口，按 workflowId 转发到下面 5 个之一
      ├─ urtoris-wf-llm-smoke   W1
      ├─ urtoris-wf-user-manager W2
      ├─ urtoris-wf-security-analysis W3
      ├─ urtoris-wf-api-gateway W4
      └─ urtoris-wf-customer-insights W5
      │  ③ 公共子工作流（Execute Sub-workflow）
      ├─ common-auth      协议校验
      ├─ common-llm      唯一一处调模型的地方（BYO Key）
      ├─ common-envelope 响应信封的唯一生成点
      └─ common-log      执行事件回写 Urtoris
      │  ④ 任何节点抛错
      ▼
urtoris-global-error-handler（全局 Error Workflow，所有正式工作流都绑了它）
      │
      ▼
Urtoris /api/n8n/events  ← 按 requestId 反查
```

**唯一需要记住的一句话**：Agent 负责决策，Workflow 负责确定性执行，Tool 负责连接现实世界。
所以不要靠"节点多"来显得高级，要靠"边界清楚"。

生成器默认按同机端口产出 URL。克隆机端口不同或使用容器时，在生成前设置：

```bash
export URTORIS_N8N_INTERNAL_BASE_URL=http://127.0.0.1:5679
export URTORIS_EVENTS_URL=http://127.0.0.1:3000/api/n8n/events
```

默认 bridge 容器里的 `127.0.0.1` 指向容器自身；当前契约下应使用 Linux host
networking，或通过上面两个变量按实际拓扑重新生成，不能只改端口映射后假设可达。

---

## 2. 常用命令

全部在本地仓库 `/Users/bird/Documents/机器人` 下执行。

| 目的 | 命令 |
| --- | --- |
| 只改工作流、要重新生成 JSON | `node tools/build-workflows.mjs` |
| 生成后先自检（**别跳过**） | `node tools/validate-workflows.mjs` |
| 部署 n8n 侧（生成→校验→上传→备份→导入→发布→核对） | `node tools/deploy-n8n.mjs` |
| 部署 Urtoris 应用（同步源码 + 在服务器上重建） | `node tools/deploy-urtoris.mjs` |
| 把 5 个工作流登记/更新到站点 | `node tools/seed-urtoris.mjs` |
| 跑端到端验收（40 条用例） | `node tools/smoke-test.mjs` |

只改工作流时的最小闭环：

```bash
node tools/build-workflows.mjs && node tools/validate-workflows.mjs && node tools/deploy-n8n.mjs && node tools/smoke-test.mjs
```

> ⚠️ 两个部署脚本都会**重启 n8n**（`deploy-n8n` 只在环境变量变化时重启；
> `deploy-urtoris` 会先停 n8n 腾内存再构建，这是防止整机失联的必要步骤）。
> 不要在比赛演示前 5 分钟跑它们。

---

## 3. 加一个新工作流（这是"可复用"的关键路径）

不需要碰任何已有工作流，三步：

1. 在 `tools/build-workflows.mjs` 里照抄 `buildLlmSmoke()` 写一个 `buildXxx()`：
   - 业务核心节点标上 `__entry: true`（第一个节点）
   - 需要调模型就 `executeWorkflow('common-llm', IDS.commonLlm, ...)`
   - 失败分支输出 `{ success: false, error: { code, message, detail, node, retryable } }`
   - 成功分支输出 `{ result: {...} }`
2. 加进 `IDS` 常量，并加入 `buildAll()` 的数组和 `publishOrder`（**子工作流必须排在业务工作流前面**）。
3. `node tools/build-workflows.mjs && node tools/validate-workflows.mjs && node tools/deploy-n8n.mjs`

框架会自动给你：Webhook + Header Auth、协议校验、错误信封、成功信封、执行日志、全局 Error Workflow 绑定。

---

## 4. 排错：从 requestId 到出错的节点

前端报错会带一个 requestId（形如 `4a1c2f7e-…`）。固定三步：

```bash
# ① 这次请求在网站侧记了什么（含 n8n executionId）
curl -s "http://127.0.0.1:3000/api/runs?requestId=<REQUEST_ID>" | python3 -m json.tool

# ② n8n 内部每一步发生了什么
curl -s "http://127.0.0.1:3000/api/n8n/events?requestId=<REQUEST_ID>" \
  -H "Authorization: Bearer $(grep URTORIS_INTERNAL_TOKEN /opt/urtoris/app/.dev.vars | cut -d= -f2)" \
  | python3 -m json.tool

# ③ 拿 executionId 直接进 n8n 看这一次执行
#    http://8.133.252.143/execution/<executionId>
```

SQL 直查（更快）：

```bash
python3 - <<'EOF'
import sqlite3, json
db = sqlite3.connect('/var/lib/urtoris/data/v3/d1/miniflare-D1DatabaseObject/' +
                     [f for f in __import__('glob').glob('/var/lib/urtoris/data/v3/d1/miniflare-D1DatabaseObject/*.sqlite') if 'metadata' not in f][0].split('/')[-1])
db.row_factory = sqlite3.Row
for row in db.execute("SELECT * FROM runs WHERE request_id = ?", ('<REQUEST_ID>',)):
    print(json.dumps(dict(row), ensure_ascii=False, indent=1))
EOF
```

### 硬失败（节点抛错，n8n 直接 500）怎么办

n8n 2.x 的 **Error Trigger 不再把触发数据传给 Error Workflow**，所以这种错误事件里没有 requestId。
Urtoris 用「同一工作流名 + ±2 分钟窗口」把两边**双向补链**：
- 运行记录里会补上 `execution_id`
- 错误事件里会补上 `request_id`

所以即使工作流被节点打死，`/api/runs?requestId=…` 仍然能拿到 executionId。这条逻辑在
`lib/server/workflow-store.ts` 的 `linkErrorEventToRun` / `linkRunToErrorEvent`。
它是**有界启发式**：宁可不匹配也不乱匹配；匹配窗口内有多条候选时取最近的一条。

---

## 5. 凭证与令牌

| 令牌 | 存放位置 | 谁用 |
| --- | --- | --- |
| `N8N_WEBHOOK_TOKEN` | n8n 凭证 `Urtoris Webhook Bearer`（加密）+ `/opt/urtoris/app/.dev.vars` | 网站 → n8n 的 Bearer |
| `URTORIS_INTERNAL_TOKEN` | n8n 凭证 `Urtoris Internal Token`（加密）+ 同一个 `.dev.vars` | n8n → 网站回传事件 |

- 明文令牌**不放在 n8n 的 `.env` 里**：n8n 2.x 默认禁止节点读环境变量，而且凭证是加密落库的。
- `.dev.vars` 权限 `600`、属主 `urtoris`，**不进 git、不进部署压缩包**。
- 本地令牌存在 `.secrets.json`（`600`，已 gitignore）。轮换令牌 = 删掉 `.secrets.json` 再跑一次 `deploy-n8n.mjs`。
- 浏览器永远拿不到这两个令牌，也不直接连 n8n。

轮换步骤：

```bash
rm .secrets.json && node tools/deploy-n8n.mjs     # 重新生成两个令牌、更新凭证、刷新 .dev.vars
```

### 5.1 BYO Key（用户自带模型密钥）会落到哪里 —— 实测结论

用户在使用端填的模型 Key 随请求透传（`context.llm.apiKey`），所以必须回答"它会不会被记下来"。
用**金丝雀密钥**（`sk-LEAKCANARY…`）跑真实失败与成功两条路径逐库搜过，结论如下：

| 位置 | 会不会记到 Key | 说明 |
| --- | --- | --- |
| Urtoris `runs` | **不会** | 只存 output 摘要与错误码 |
| Urtoris `n8n_events` | **不会** | 只存事件消息与响应/错误对象 |
| systemd 日志（n8n / urtoris） | **不会** | 实测 `grep` 0 命中 |
| n8n `execution_data`（**失败**执行） | **不会** | 实测：失败执行只落节点元数据与 error，**不落 item 数据** |
| n8n `execution_data`（**成功**执行） | **会** ⚠️ | 当前生产基线 2.35.7 必须保持 `all`，因此会保存；只用一次性测试 Key，升级验证前不要投入生产 Key |

> ⚠️ **`URTORIS_DEBUG_DATA=1` 会把用户 API Key 明文写进 n8n 的 `execution_data`**（已实测确认）。
> 调试期间请用一次性测试 Key，不要用生产 Key；调完记得不带这个变量重新部署一次。


---

## 6. execution 数据（防止小机器被撑爆）

`/opt/n8n/.env` 里的设置：

```ini
EXECUTIONS_DATA_PRUNE=true
EXECUTIONS_DATA_MAX_AGE=72                 # 官方默认 336 小时（14 天）→ 我们 3 天
EXECUTIONS_DATA_PRUNE_MAX_COUNT=2000       # 官方默认 10000 → 我们 2000
EXECUTIONS_DATA_HARD_DELETE_BUFFER=1
EXECUTIONS_DATA_SAVE_ON_SUCCESS=all        # ⚠️ 绝不能设 none，见下方"坑"
EXECUTIONS_DATA_SAVE_ON_ERROR=all
EXECUTIONS_DATA_SAVE_ON_PROGRESS=false
EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS=false
EXECUTIONS_TIMEOUT=90                      # 任何工作流都不允许无限挂住
EXECUTIONS_TIMEOUT_MAX=180
```

### ⚠️ 坑：`SAVE_ON_SUCCESS=none` 会让执行记录永远不定稿（已踩过）

把成功执行的数据保存关掉之后，n8n 2.35.7 **连 `execution_entity` 的最终状态更新也一并跳过** ——
执行行永远停在 `status='running'`。

症状极具迷惑性：接口全部返回 200、工作流跑得好好的，但 n8n 界面的执行列表里堆着一大片"运行中"，
执行计数全是错的。实测堆积 100+ 条，**重启也不恢复**。

排查过程（记录一下，下次 5 分钟定位）：对比"已定稿"和"悬挂"的执行分别属于哪些工作流 ——
定稿的全是 `saveDataSuccessExecution: 'all'` 的全局错误处理器，悬挂的全是设成 `'none'` 的业务工作流与公共子工作流。

**对生产 2.35.7 的结论**：`EXECUTIONS_DATA_SAVE_ON_SUCCESS` 和工作流的
`saveDataSuccessExecution` 都必须保持 `all`。`tools/validate-workflows.mjs` 已把
`none` 列为**错误**，生成阶段就会拦下。

### n8n 2.38.6 的隔离复验结果（2026-09-11）

在本机复制数据库上同时把**全局变量和 11 个工作流级设置**改为 `none`，随后真实
并发执行 W1 / W2。n8n 分配了 execution id 46–57；完成后：

```text
execution_entity WHERE id >= 46  → 0 行
execution_data   WHERE id >= 46  → 0 行
永久 running                       → 0 行
```

即 2.35.7 的悬挂故障在 2.38.6 该样本中没有复现。注意只改环境变量无效：生成产物
当前显式写着 `saveDataSuccessExecution: 'all'`，会覆盖全局设置。生产仍不改；必须先
用生产数据克隆完成升级、重复执行与观察窗口，再决定是否同时调整生成器门禁和工作流设置。

### 那磁盘怎么办？交给 pruning，而不是"不写"

- 2000 条上限 × 每条约 5–10KB ≈ 8–20MB，对 40G 盘毫无压力
- 真正撑爆机器的是**官方默认的 14 天 / 10000 条**，不是"保存成功数据"这件事本身
- 可观测性另有兜底：网站 `runs` 表记 requestId/executionId/耗时/错误码，n8n 侧 `common-log`
  把每次执行的结局写进 `n8n_events`；执行数据被 prune 掉也不影响排错链条

### 清理悬挂的执行行

如果又冒出一堆 `running`（例如有人又把 success 保存关掉了）：

```bash
systemctl stop n8n
python3 - <<'EOF'
import sqlite3
db = sqlite3.connect('/root/.n8n/database.sqlite')
n = db.execute("select count(*) from execution_entity where status='running'").fetchone()[0]
db.execute("delete from execution_data where executionId in (select id from execution_entity where status='running')")
db.execute("delete from execution_entity where status='running'")
db.commit()
db.execute("VACUUM"); db.commit()
print(f"已清理 {n} 条")
EOF
systemctl start n8n
```

### 看当前占用

```bash
du -h /root/.n8n/database.sqlite
python3 -c "import sqlite3;db=sqlite3.connect('/root/.n8n/database.sqlite');print('executions',db.execute('select count(*) from execution_entity').fetchone()[0]);print('running',db.execute(\"select count(*) from execution_entity where status='running'\").fetchone()[0])"
```

立即清空历史执行（不影响工作流定义）：

```bash
systemctl stop n8n
python3 -c "
import sqlite3
db=sqlite3.connect('/root/.n8n/database.sqlite')
db.execute('DELETE FROM execution_data'); db.execute('DELETE FROM execution_entity'); db.commit()
db.execute('VACUUM'); db.commit()"
systemctl start n8n
```

---

## 6.1 回滚演练（已实测通过）

`tools/remote/rollback_drill.py`：校验最新备份完整性 → 记录现场 → 停服 → 换库 → 清 wal/shm
→ 起服 → 核对表数据一致 → 验证站点恢复。

实测结果（2026-09-10）：

```
最新备份完整性: ok
备份内容:   {workflow_entity: 17, webhook_entity: 7, credentials_entity: 2, execution_entity: 41}
回滚完成，n8n 就绪: True，耗时 29.9s
回滚后库内容: {workflow_entity: 17, webhook_entity: 7, credentials_entity: 2, execution_entity: 41}
与备份内容一致: True
站点恢复: True
```

**结论**：维护窗口按 **2 分钟**留足够（停服+恢复约 30s，其余是验证）。升级 n8n 前跑这个脚本做预演即可。
演练会把当前库另存为 `database.sqlite.predrill` 作为退路。

> 注意：回滚会把执行记录退回备份时的状态（演练中 150 条 → 41 条）。工作流定义、webhook 注册、
> 凭证都不受影响。执行数据本身就是可丢弃的日志，不需要备份。

---

## 7. 故障处置

| 现象 | 先看什么 | 常见原因 |
| --- | --- | --- |
| 网站报 `[UNAUTHORIZED]` / `[FORBIDDEN]` | 两边令牌是否一致 | 轮换过令牌但只更新了一侧 → 重跑 `deploy-n8n.mjs` |
| 网站报 `[NOT_FOUND]` | `webhook_entity` 表 | 工作流改了但没 Publish（**必须发布，不是只保存**） |
| 网站报 `[TIMEOUT]` | n8n 执行时长 | 模型太慢 / 外部 API 卡住；`common-llm` 自身超时 30s，网关转发上限 38s，客户端 45s |
| W1/W2/W5 显示 `mode=rules, degraded=true` | 前端有没有填 Key | 正常降级：BYO Key 没填，不调用模型；不能显示成“真实 AI 成功” |
| 网站报 `[LLM_NOT_CONFIGURED]` | 是否直接调用了 `common-llm` 或未实现规则兜底的工作流 | 公共模型层会明确报未配置；W1/W2/W5 应自行转入规则兜底 |
| n8n 界面里节点显示成 `?` | 节点 `type` 前缀 | 忘了 `n8n-nodes-base.` 前缀（**导入会"成功"，但运行时报 Unrecognized node type**） |
| 工作流"通了但结果是错的" | Switch 的 `conditions` 结构 | Switch v3 每条规则的 `conditions` 必须是**过滤器对象**（`conditions.conditions[]`），写成 V1 的裸条件不会报错，但所有项都会落到 output 0 |
| 某个 HTTP 节点结果取不到 | `body` vs `data` | 响应头不是 `application/json`（例如 RDAP 的 `application/rdap+json`）时，n8n 把响应体放在 `data`（字符串）而不是 `body` |

```bash
systemctl status n8n urtoris
journalctl -u n8n -n 100 --no-pager
journalctl -u urtoris -n 100 --no-pager
ls -la /root/.n8n/backup-*-predeploy.sqlite     # deploy-n8n 每次都会备份，保留最近 5 份
```

**回滚 n8n 数据库**（例如某个工作流把库搞坏了）：

```bash
systemctl stop n8n
cp /root/.n8n/backup-<时间戳>-predeploy.sqlite /root/.n8n/database.sqlite
rm -f /root/.n8n/database.sqlite-wal /root/.n8n/database.sqlite-shm
systemctl start n8n
```

---

## 8. 什么时候才上 Queue Mode

**现在不要上。** 2C/1.6G 上再塞 Redis + Worker + PostgreSQL 是给自己制造事故。

升级到 4C8G 之后再考虑：

```
Nginx → Urtoris → n8n Main → Redis → Worker × N → PostgreSQL
```

判据（满足任意两条再动手）：并发执行经常排队、单次执行经常 >30s、`free -m` 的 available 长期 <400M。

---

## 9. 幂等与重复请求（三个入口行为一致）

`/api/agent/chat`、`/api/runs`、`/api/v1/run` 共用同一套策略，实现见 `lib/server/replay.ts`：

| 情况 | 行为 |
| --- | --- |
| 调用方没给 `requestId` | 服务端生成，正常执行 |
| `requestId` 格式非法 | `400`（白名单：`[A-Za-z0-9._:-]`，8–80 位） |
| 同一 `requestId` 已成功/失败过 | **重放**：返回同一条运行记录（`replayed: true`），**不再触发 n8n** |
| 同一 `requestId` 正在执行中 | 等最多 8 秒等它落库；等到了就重放，否则 `409 REQUEST_IN_PROGRESS`（带 `Retry-After: 2`） |
| 同一 `requestId` 换了工作流 | `409`，视为调用方串了 ID |

两层保护缺一不可：
- `runs.request_id` 唯一索引 —— 防**重复记录**
- `run_claims` 表 —— 防**重复执行**（对"建用户"这类有副作用的流程才致命）

`run_claims` 有 120 秒 TTL：进程崩了不会把某个 requestId 永久卡死；执行结束会立即释放，表不会无限增长。

---

## 10. 对外暴露面

| 端口 | 谁在听 | 对外 |
| --- | --- | --- |
| 22 | sshd | 安全组放行（**建议收紧到固定来源 IP**） |
| 80 / 443 | nginx | 公开；80 上 `default_server` 反代到 n8n |
| **5678** | n8n | **已绑 `127.0.0.1`**（`N8N_LISTEN_ADDRESS`），公网不可达 |
| 3000 | Urtoris | 绑 `127.0.0.1`，只经 nginx 暴露 |

防护是四层的，任何一层单独都不够：

1. **网络**：n8n 只监听回环，公网必须经 nginx。
2. **鉴权**：所有 `/webhook/urtoris/*` 都是 Webhook 节点的 Header Auth（`Authorization: Bearer <N8N_WEBHOOK_TOKEN>`），
   在进入工作流之前就返回 403，不消耗执行。
3. **限流**：`/etc/nginx/conf.d/urtoris-limits.conf` 定义 `urtoris_webhook` 区（20 r/s，burst 40），
   只挂在 `/webhook/` 上。**站点直连 127.0.0.1:5678，不受此限流影响**。
4. **体积**：`/webhook/` 限 `client_max_body_size 128k`（协议本身要求 ≤32KB）；编辑器路径保留 20m 以便导入工作流。

> 已实测：公网 `:5678` 目前拿不到响应，但**这是安全组的运气，不是配置的保证**。
> 谁哪天在控制台把 5678 放开，n8n 编辑器就会直接暴露 —— 现在绑回环之后这层才真正成立。



## 11. 已知边界（写清楚，免得以后误判）

1. **`$env` 在 n8n 2.x 节点里读不到** —— 所有需要令牌的地方都用加密凭证，不要试图用 `{{ $env.X }}`。
2. **n8n 只有 Publish 才会注册 webhook** —— 用 CLI 改 `active` 没用。`deploy-n8n.mjs` 走的是
   `POST /rest/workflows/{id}/activate`，等价于界面里点 Publish。
3. **发布顺序有依赖** —— 子工作流必须已发布，引用它的工作流才能发布成功，所以 `manifest.publishOrder` 不能随便改。
4. **域名入口仍然受备案限制** —— 网站目前只能通过 `127.0.0.1:3000` 或已备案域名访问，n8n 用 IP `8.133.252.143`。
5. **旧工作流 `wfUrtorisTest01`（客服问题分流）仍是裸 JSON 返回值**，靠客户端的兼容层包成 v1 信封。
   它是有意留着的兼容性样本，不要删。
