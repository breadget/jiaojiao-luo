# 隔离 Graph Runtime Canary Runbook

更新：2026-09-13。基线 `origin/main@0f14948`，分支 `codex/graph-runtime-canary`。
架构见 [ADR 001](ADR-001-GRAPH-RUNTIME-EVENTS.md)，本轮机器可读结果见
[evidence/graph-runtime-canary.json](evidence/graph-runtime-canary.json)。
旧记录完整保留在 [2026-09-11 历史记录](CANARY_HISTORY_2026-09-11.md)，其中的历史通过项不代替本轮证据。

## 边界与前置检查

**禁止连接生产 n8n、生产数据库或生产模型 Key。Deploy 继续 Adapter locked。**
本轮为 Windows 本机独立 SQLite 配置/数据目录、独立 workerd D1、真实 n8n 2.38.6，
模型使用本地 OpenAI 兼容替身。它验证执行引擎与协议，不声称访问过 DashScope，
也不声称已演练生产数据备份的升级。生产备份及原版本配置没有提供，不能补造该证据。

开始前逐项核对：

1. 新 checkout 必须从 `0f14948` 创建，现有工作目录、数据库、迁移和历史测试保留。
2. 克隆根目录使用独立绝对路径，名字含 clone/canary；磁盘有足够空间保存全部 execution data。
   禁止把生产目录、网络共享或指向生产数据的 junction/symlink 用作克隆目录。
3. 本轮新建配置和数据库。若后续使用运维提供的**离线脱敏备份**，先核对来源、校验和、
   导出时的 n8n/数据库版本、加密配置以及恢复命令；备份原件只读，迁移只在第二份复制件执行。
   清除旧凭据、Webhook URL、错误工作流、外部数据库/Redis/SMTP 配置，所有工作流先停用。
   不运行远端 dump、迁移或升级命令。
4. 检查继承的 DB_TYPE、DB_SQLITE_DATABASE、DB_POSTGRESDB_*、EXECUTIONS_MODE、
   QUEUE_BULL_REDIS_*、N8N_USER_FOLDER、N8N_ENCRYPTION_KEY；不能继承生产配置。
   启动脚本强制 sqlite / regular / internal runner，数据只写入 clone-data/.n8n。
5. 站点 3000、n8n 主服务 5679、JS runner broker 5680、模型替身 5690 均只监听 loopback。
   5679 的 /healthz 单独不足以证明 n8n 主服务已启动；还要检查 /rest/settings 与真实 Webhook。
6. 必须同时存在环境变量 `URTORIS_CLONE_CANARY=1` 和文件 `graph-runtime-clone.json`，
   marker 为 `isolated-urtoris-graph-canary`，版本为 `2.38.6`。forwarder 校验数据库 realpath
   在克隆目录内、只读打开，并拒绝非固定 loopback 事件地址。

## 准备运行时与 D1

以下 PowerShell 命令在独立 checkout 执行。`$cloneRoot` 不得指向现有用户目录或生产目录。
本轮目录是 `D:\202609\graph-canary-runtime`；重做时使用一个新的空目录。
Node 需要支持 node:sqlite（本轮 v24.19.0）。应用依赖按仓库锁文件安装。
本轮没有 Docker/WSL，使用 npm 分发的 n8n 真正启动主进程和 JS runner。

```powershell
$cloneRoot = 'D:\202609\graph-canary-repro'
$env:URTORIS_CLONE_CANARY = '1'
New-Item -ItemType Directory -Path $cloneRoot
$env:npm_config_cache = Join-Path $cloneRoot 'npm-cache'
# 可用 npm install --prefix；本轮实际用 pnpm 10 的独立前缀安装。
pnpm --dir $cloneRoot --store-dir (Join-Path $cloneRoot 'pnpm-store') add n8n@2.38.6
node (Join-Path $cloneRoot 'node_modules/n8n/bin/n8n') --version
node --import tsx deploy/n8n/prepare-graph-clone.ts $cloneRoot
```

若 pnpm 禁用了原生安装脚本，需要在此克隆运行时批准并构建 sqlite3 / isolated-vm。
本轮 sqlite3 经 `npm rebuild sqlite3 --prefix $cloneRoot` 后能加载。
Windows 跨盘 npm cache 曾导致 EXDEV；使用克隆所在盘的 npm cache 后解决。
不得以“只有 /healthz”或 CLI --version 当作真实 Canary 通过。

prepare 脚本拒绝覆盖已有 `.dev.vars` 或 clone marker；生成随机一次性测试凭据，
只写入被忽略的 `.dev.vars` 与克隆根目录，不读取旧环境密钥。
脚本同时生成本地 D1 配置和完整 0000–0009 SQL。新库执行一次：

```powershell
npx.cmd wrangler d1 execute site-creator-d1 --local --persist-to .wrangler/state --config outputs/canary.wrangler.json --file outputs/canary-migrations.sql
node node_modules/vinext/dist/cli.js dev --hostname 127.0.0.1 --port 3000
```

已存在的**离线克隆库**先用 PRAGMA table_info / sqlite_master 核对已应用迁移，
只执行缺失迁移，不能重放整个建表脚本。本次新增 `0009_graph_runtime_events.sql`：
`n8n_runtime_streams` 固定绑定版本与 sourceSeq，`n8n_runtime_receipts` 保存幂等收据。
旧 `0007/0008`、Graph/WorkflowStep 原子双写范围均不改动。

另一个终端发布站点 Graph，物化只含 credential ID 的 n8n 导入副本：

```powershell
$env:URTORIS_CLONE_CANARY = '1'
node --import tsx deploy/n8n/run-graph-canary.ts $cloneRoot --setup
node --import tsx deploy/n8n/materialize-graph-clone.ts $cloneRoot
$env:N8N_USER_FOLDER = Join-Path $cloneRoot 'clone-data'
$env:DB_TYPE = 'sqlite'
$env:DB_SQLITE_DATABASE = 'database.sqlite'
node (Join-Path $cloneRoot 'node_modules/n8n/bin/n8n') import:credentials --input="$cloneRoot/credentials.json"
node (Join-Path $cloneRoot 'node_modules/n8n/bin/n8n') import:workflow --input="$cloneRoot/workflow.json"
node (Join-Path $cloneRoot 'node_modules/n8n/bin/n8n') publish:workflow --id=urtoris-graph-canary
```

实际 n8n 2.38.6 使用 `publish:workflow`；发布命令提示必须重启主进程才生效。
发布 Graph 快照、物化导入副本、n8n publish 是三个明确步骤；不解锁站点 Deploy。
原始编译产物只有 credentialRef，挂载后导入副本不是原始 golden，分别记录 hash。

## 11 个工作流：导入和激活顺序

本仓库不包含生成器本体。需要只读工具链 `generated/all-workflows.json` 和
`generated/manifest.json`；本轮使用同工作区已有工具链，无生产访问。
prepare-family 只改导入副本的 loopback 端口 5678 → 5679，不修改工具链源文件。

```powershell
node --import tsx deploy/n8n/prepare-family-clone.ts $cloneRoot 'D:\202609\jiaojiao-luo-toolchain\generated'
node (Join-Path $cloneRoot 'node_modules/n8n/bin/n8n') import:credentials --input="$cloneRoot/family-credentials.json"
node (Join-Path $cloneRoot 'node_modules/n8n/bin/n8n') import:workflow --input="$cloneRoot/family-workflows.json"
$familyOrder = Get-Content -Raw (Join-Path $cloneRoot 'family-import-order.json') | ConvertFrom-Json
foreach ($workflowId in $familyOrder) {
  node (Join-Path $cloneRoot 'node_modules/n8n/bin/n8n') publish:workflow --id=$workflowId
  if ($LASTEXITCODE -ne 0) { throw "Publish failed: $workflowId" }
}
```

顺序固定为：

1. urtoris-common-auth
2. urtoris-common-llm
3. urtoris-common-envelope
4. urtoris-common-log
5. urtoris-global-error-handler
6. urtoris-wf-llm-smoke
7. urtoris-wf-user-manager
8. urtoris-wf-security-analysis
9. urtoris-wf-api-gateway
10. urtoris-wf-customer-insights
11. urtoris-gateway

批量文件先导入依赖关系，逐个按上述顺序 publish，最后重启。核对 `workflow_entity`
中 11 个 activeVersionId 均非空以及启动日志的激活记录。
本轮 11 个工作流验证导入/激活；Qwen/Memory/Condition 真实执行矩阵针对 Graph 产物，
不能把它写成 11 个业务工作流都完成了端到端业务验收。

## 凭据挂载与事件服务

| credentialRef / 导入 ID | n8n credential 类型 | 内容来源 |
| --- | --- | --- |
| headerAuth / canary-webhook | httpHeaderAuth | Authorization: Bearer + 随机测试 webhook token |
| urtorisEventsHeaderAuth / canary-internal | httpHeaderAuth | Authorization: Bearer + 随机 URTORIS_INTERNAL_TOKEN |
| openAiApi / canary-model | openAiApi | 随机测试 apiKey，base URL 仅 http://127.0.0.1:5690/v1 |
| 11 工作流的 urtoris-internal-token / urtoris-webhook-auth | httpHeaderAuth | 同一组克隆测试 token 的独立引用 ID |

站点内部事件接口只接受正确 Bearer；HTTP 守卫要求 200 且 JSON 的 ok、bound 都是布尔 true。
400/401/404/409/503（即使 body 声称 ok）停止在危险节点之前。
启动三个独立终端；不要输出 test-secrets 内容：

```powershell
$env:URTORIS_CLONE_CANARY = '1'
./deploy/n8n/start-graph-clone.ps1 -CloneRoot $cloneRoot
# 第二个终端
node --import tsx deploy/n8n/local-qwen-substitute.ts $cloneRoot
# 第三个终端
$cloneSecrets = Get-Content -Raw (Join-Path $cloneRoot 'test-secrets.json') | ConvertFrom-Json
$env:URTORIS_INTERNAL_TOKEN = $cloneSecrets.internal
node --import tsx deploy/n8n/forward-graph-executions.ts $cloneRoot
```

`EXECUTIONS_DATA_SAVE_ON_SUCCESS=all`、`EXECUTIONS_DATA_SAVE_ON_ERROR=all` 必须同时在
全局环境及 workflow settings 为 all；观察期间不裁剪 execution data。不要用 none。
forwarder 仅转换终态快照；进程崩溃/缺快照保留 pending，不造成功。
逐事件等待 ACK；转发进程遇到拒绝或断网非零退出，修复配置/站点服务后原命令重启，
从 SQLite 重放，D1 receipts 去重。不能删除收据后“重试”。

## 执行矩阵与观察

```powershell
node --import tsx deploy/n8n/run-graph-canary.ts $cloneRoot
node --import tsx deploy/n8n/setup-no-key-canary.ts $cloneRoot
# 停止 n8n 和 forwarder，再导入/发布 no-key，重启两者以加载新的 marker。
node (Join-Path $cloneRoot 'node_modules/n8n/bin/n8n') import:workflow --input="$cloneRoot/nokey-workflow.json"
node (Join-Path $cloneRoot 'node_modules/n8n/bin/n8n') publish:workflow --id=urtoris-graph-nokey
node --import tsx deploy/n8n/check-no-key-canary.ts $cloneRoot
```

六例矩阵验证 body 展平、request/session/question/channel/urgency、同 session 上下文复用、
不同 session 隔离、high true / normal false、合法 envelope、模型成功、401、TCP 断开和异常 JSON。
替身的 401 模式代表测试凭据被提供方拒绝，不使用真实云 Key；TCP 主动断开验证 NETWORK_ERROR。
无 Key 必须显式 `credentialRef=none` + `fallbackPolicy=rules`，返回 rules/degraded=true，
模型与 Memory 不执行并标 skipped。已声明凭据引用却忘记挂载是配置失败，不应悄悄变规则成功。
Simple Memory 跨本机执行复用，重启后不持久，也不声称支持多 worker 共享上下文。

绑定拒绝实测：停止 n8n；生成并导入五个故障副本；逐个 publish；重启：

```powershell
node --import tsx deploy/n8n/prepare-binding-faults.ts $cloneRoot
node (Join-Path $cloneRoot 'node_modules/n8n/bin/n8n') import:workflow --input="$cloneRoot/binding-faults.json"
foreach ($status in 400,401,404,409,503) {
  node (Join-Path $cloneRoot 'node_modules/n8n/bin/n8n') publish:workflow --id="urtoris-graph-bind-$status"
}
# 重启后
node --import tsx deploy/n8n/check-binding-faults.ts $cloneRoot
```

故障副本指向本地状态注入器，只有 URL 不同；实际执行数据须仅含 Webhook、校验、绑定、守卫，
Agent/Model/Memory/HTTP/Tool/Robot 均未执行。它们是故障测试副本，不冒充原始编译产物。

未映射节点实测：`prepare-unmapped-canary.ts` 生成带一个真实额外 Code 节点的导入漂移副本；
停止 n8n 后导入 `unmapped-workflow.json`、publish `urtoris-graph-unmapped`，重启 n8n 和 forwarder，
运行 `check-unmapped-canary.ts`。脚本临时切换**克隆**既有绑定，finally 恢复原 URL；
若进程被强杀，先从本轮 graph.json 和固定 loopback URL 恢复绑定再继续。
额外节点只能显示 unmapped，不能猜内部 ID。

浏览器验收使用独立安装的 Playwright 和本机 Edge：设置 `CANARY_EDGE_PATH`，运行
`check-studio-canary.ts`。浏览器使用临时 profile 并阻止非 loopback 请求。
可用 `pnpm --dir $cloneRoot add playwright@1.63.0` 安装浏览器驱动；
本轮 Edge 路径为 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`。
由于 Run 按钮目前没有 prompt 输入框，测试驱动只在发出的请求里补入合成测试输入；
不模拟任何 HTTP 响应、n8n 执行或 telemetry。成功 DOM 为 6 success + 1 skipped，
401 后为 2 个 error 节点，Inspector 显示 code/message/脱敏 detail，两次都到达已定稿；Deploy disabled。
截图和原始执行数据留在克隆目录，不把密钥或原始提示上传到仓库。

实际 HTTP 协议复核运行 `check-runtime-protocol.ts`：重放已保存的真实 binding 得到
200/duplicate，错误 token 401、无效请求 400、未知工作流 404，execution/workflow/session/version
冲突和终态后的 node.started 均 409。以 limit=3 分页重拉与完整事件序列逐个比较。
`check-forwarder-reconnect.ts --begin` 须在 forwarder 停止时执行：虽然模型完成，telemetry
只能看到 binding，仍是 running；重启 forwarder 后执行 `--finish`，补齐事件且无重复/丢失。
这些脚本只发真实 HTTP，不模拟 D1 或引擎结果。

最终版本启动后完整观察至少 **30 分钟**：

```powershell
node --import tsx deploy/n8n/observe-graph-clone.ts $cloneRoot
```

若工具托管的长任务在会话恢复时退出，可用 Windows 隐藏进程启动器代替上述前台终端：
`start-canary-services.ps1 -CloneRoot $cloneRoot` 记录各 helper 的 PID 和启动时间；
主服务就绪后用 `-Only observation` 启动观察器，转发器恢复用 `-Only forwarder`。
已有活进程/manifest 时不重复全量启动。停止时用 `stop-canary-services.ps1`，核对 PID
和启动时间后仅停止该克隆的进程树。它不删除数据库、配置或日志。
本轮一次工具会话中断导致最终版观察仅到约 5 分钟，因此该窗口作废；随后从零重跑，
只有最终完整窗口计入验收。前一版已完成的 30 分钟记录保留为历史证据。

脚本每 15 秒只读检查 execution_entity：

```sql
SELECT id, workflowId, status, startedAt, stoppedAt
FROM execution_entity
WHERE status='running' AND stoppedAt IS NULL
  AND julianday(startedAt) < julianday('now','-2 minutes');
```

必须零行；窗口末尾全部 running 为 0。`observation.json` 必须 complete=true、pass=true，
不能截短窗口。启动日志、SQLite/WAL、测试结果、本地 D1 状态保留到验收结束。

## 回滚与恢复演练

先停止接入新请求，再停止克隆 n8n 和 forwarder。离线备份 clone-data（包含 config、SQLite/WAL），
保留原件。使用已有历史的**精确** n8n versionId，不能重新编译覆盖历史：

```powershell
# 本轮真实旧版本和当前版本；复现环境须查询自己的 workflow_history，不能套用这些 UUID。
node --import tsx deploy/n8n/rollback-graph-clone.ts $cloneRoot 2 73724cbd-107e-469f-9c57-240c41779338
# 重启 n8n、forwarder
node --import tsx deploy/n8n/check-rollback-canary.ts $cloneRoot
# 再停止两个进程，恢复当前版本
node --import tsx deploy/n8n/rollback-graph-clone.ts $cloneRoot 3 b582bb3b-78fe-4043-9eb3-444d01ea19e9
# 重启后再执行 check-rollback-canary.ts
```

helper 校验 clone marker、sqlite 路径、历史节点中 graphVersion 与 Webhook ID；核心命令为
`n8n publish:workflow --id=<clone-workflow> --versionId=<history-version>`，然后调用站点旧版 rollback API。
Graph 发布指针只移动，历史版本和 bindings 不删除。CLI 或站点切换失败保持服务停止；
修复后重做两边切换，不能在版本不一致时继续发请求。
校验 high/normal 两次运行、execution.bound 第一条、终态 completed、boundVersion 正确。
最后恢复当前版本，检查 11 个 workflow 激活、陈旧 running 为零。

## 全量检查与证据导出

依次执行 `npm test`、`npx tsc --noEmit`、`npx oxlint`、`npm run build`，每项必须 exit 0。
Windows 使用 npm.cmd/npx.cmd，避免 PowerShell 包装器丢弃参数。
可设置 `URTORIS_TOOLCHAIN_GENERATED_DIR` 指向只读工具链 generated，启用跨仓库契约测试。
保留日志为 `outputs/final-test.log`、`final-tsc.log`、`final-oxlint.log`、`final-build.log`，
并将实际命令/退出码数组写入 `outputs/final-validation.json`。
运行 `node --import tsx deploy/n8n/collect-graph-canary.ts $cloneRoot --final`，它会检查原始执行、
输入、错误脱敏、11 个激活状态、确定性 hash、全部检查结果和观察时长后才写入
`docs/evidence/graph-runtime-canary.json`。不带 --final 只写克隆目录内的预览，不冒充通过。
只有观察完成、所有断言通过时 complete 才能为 true。

本轮 npm test 为 291 项，290 通过，1 项既有可选真实云 Qwen Key 测试因无云 Key 跳过；
允许的本地替身方案已在真实 n8n 跑完全部 Canary，没有跳过实际引擎验证。

## 失败处理、清理与生产状态

任意断言失败先保存脱敏结果，停止测试接入，再 Ctrl+C 停止四个本机服务和观察器。
保留 DB/配置供只读诊断；不要把“无事件”改成成功，也不要删除失败 execution 伪造干净统计。
若 forwarder 失败，修复后重启重放；如果快照已丢失，保持未完成并明确记录阻塞。

仅在不再需要本机复核后清理本任务创建的数据目录。先检查 Resolve-Path 的绝对路径、clone marker，
确认服务停止，且待删目录严格处于指定 cloneRoot 内，再用同一 PowerShell 的
`Remove-Item -LiteralPath <已核对的目录> -Recurse`；不跨 shell 拼接删除命令，不删除 pnpm/node_modules
junction 的外部目标。本轮默认保留克隆证据，停止进程即可回收运行资源。
关闭本地 `.dev.vars` 的 Canary 开关即可恢复 503；该文件本来就不提交。

生产保持关闭：缺少生产离线备份迁移证据、queue/多进程/外部数据库 forwarder 实现、
生产服务监督与容量验证。当前实现专用于单机 SQLite 克隆；不能依据本轮测试批准生产升级。
最小外部前置条件是运维提供脱敏离线备份及原版本/配置清单；后续只在另一隔离环境恢复、
重跑迁移与 30 分钟观察，另行评审生产启用。本轮不需要真实 API Key。
