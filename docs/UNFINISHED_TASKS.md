# 未完成项目清单

更新时间：2026-09-15

本文只记录尚未完成或尚未在生产环境验收的事项。已完成的 P0 网站安全补丁已进入代码工作树，但在完成生产发布和实测前不能视为生产闭环。

## 2026-09-15 本机全权限 Control Agent

- [x] 新增独立 loopback-only Control Agent，用独立 bearer token 与站点通信；浏览器不持有 token。
- [x] `run_shell` 可执行当前 macOS 用户有权执行的任意 zsh；异步返回 `run_id`、轮询终态、进程组取消、超时与重启失败语义已落地。
- [x] 站点路由同时要求显式开关和本机同源请求；公网域名、代理公网来源、跨站请求全部 fail closed。
- [x] 使用端增加「本机全权限」模式、真实身份/主机/Shell/目录公示、命令台账、已用时间与取消。
- [x] `npm run dev:control` 一键启动站点与 Control Agent；私有环境文件与审计目录权限收紧为 `0600/0700`。
- [x] 本机网页用无 Key 的 OpenAI 兼容测试模型完整执行 `pwd; id -u`，页面显示成功终态、输出与 `run_id`。
- [x] 修掉执行器的真实缺陷：`error`/`exit`/`close` 是一次性事件，命令比「运行中」快照落盘更快时事件会丢，运行永远停在 `running` 并占住唯一并发位（并发测试里 10 次有 3 次复现）。现在监听器在第一个 `await` 之前挂上，同一次运行的三次落盘串行执行，劣化的 `running` 快照无法覆盖终态。
- [x] 命令退出后如果输出管道被它留下的后台进程继续持有，最多再等 2 秒就按退出码定稿，不再把并发位吊到命令超时；两处都有回归用例，全量测试从 20 秒降到约 8 秒且三轮 411/411 稳定通过。
- [x] 新增可复跑的真实门禁 `npm run control:gate`（9 项，打正在运行的 Control Agent）：身份与非本机入口、连发 8 条快命令、非零退出、取消并确认进程组消失、超时、后台进程占管道、幂等与跨任务隔离、审计与文件权限；证据 [`evidence/local-control-review.json`](evidence/local-control-review.json)。
- [x] `npm run dev:control` 在 3000 端口已被占用时提前拒绝并打印占用进程，不再「启动了 Control Agent 又立刻把它停掉」而让页面看起来像没生效。
- [ ] 使用真实支持 tool calls 的模型再做一次本机端到端；当前是确定性本地模型替身，没有传输真实 Key。
- [ ] 不开放 root、不自动处理 sudo 密码、不绕过 macOS 隐私权限；若以后需要，必须单独设计授权与审计。
- [ ] 不连公网站点、不做节点注册或隧道；远程控制需要新的威胁模型，不属于这个本机开关。

## 2026-09-15 本地长任务方案

- [x] 本机节点握手定案：Colima + loopback + 独立 bearer token，仅服务本人，不注册、不建隧道。
- [x] Executor 异步提交、终态轮询与取消；`short` / `long` 档位及资源限制已落地。
- [x] 网站 Agent 改为提交后轮询；会话、消息、Python 运行与产物引用落 D1，刷新/重开可恢复。
- [x] 运行台账改分页，使用端显示排队中/运行中、已用时长和取消入口。
- [x] 本机一键启动脚本、Docker 门禁与真实分钟级任务证据已归档：
  [`python-executor-local-gates.json`](evidence/python-executor-local-gates.json)、
  [`python-executor-long-run.json`](evidence/python-executor-long-run.json)。
- [x] 浏览器验收会话刷新恢复、运行记录与 390 / 1024 宽度无横向溢出：
  [`consumer-session-ui.json`](evidence/consumer-session-ui.json)。
- [x] 执行器进程在真实 Docker 任务运行中被强制终止并重启：残留容器从 1 个清理到 0 个，同一 `run_id` 定稿为 `failed/WORKER_ERROR`，零产物；另有启动恢复回归测试。
- [ ] 合盖/休眠与断网的物理中断尚未人为触发；上述门禁覆盖了持久化运行的恢复路径，但证据没有把进程中断冒充为物理休眠实测。

## Python Executor MVP（pre-Agent）

- [x] 冻结 MVP 边界、`run_python` v1 契约和容器安全策略。
- [x] 实现独立 loopback-only Executor、严格请求校验、串行队列、受控 `file_id`、幂等、每任务三次上限、状态/日志/审计落盘和启动恢复。
- [x] 实现 Docker 参数与生效策略核验：非 root、无网络、只读根、1 CPU、512 MiB、PID/文件数限制、cap-drop、no-new-privileges、tmpfs 输出和终态清理；生产要求 image digest 与 LSM。
- [x] 实现 CSV/JSON/TXT/PNG 全有或全无产物回收，PNG 在第二个隔离容器中用 Pillow 完整解码。
- [x] 实现网站 `/api/python/*` 转发、loopback SSRF 门禁、独立内部 token，以及无账号阶段七天有效的 task capability。
- [x] 增加协议、核心、HTTP、网站客户端与 capability 自动化测试；十一项真实 Docker 门禁已写成显式开关的集成测试。
- [x] 按 `docs/python-agent-system-prompt.md` 实现 Agent 侧状态机：逐字复用该系统提示词、注入 task/file 授权上下文、把 `run_python` 作为 OpenAI 兼容协议的 function tool 下发、最多三次尝试、相同 `error_fingerprint` 立即停止、`timed_out`/`MEMORY_LIMIT`/`POLICY_VIOLATION`/`WORKER_ERROR`/清理失败/工具级拒绝不自动重试，并用确定性模板兜底最终回答（模型把失败写成成功时替换掉它的叙述）。
- [x] 增加 Agent 侧测试：提示词与文档逐字比对、参数校验、修复/停止状态机、诚实性兜底、`/api/python/agent` 的关闭态 503、capability 403 与成功/失败链路。
- [x] 在香港 ECS（`43.132.210.43`，Ubuntu 24.04 / Docker 29.6.1）构建镜像并跑完真实容器门禁：普通执行、真实语法错误、死循环超时、内存耗尽、网络不可达、宿主文件不可读、超大日志截断、CSV/PNG 产物回收、受控输入可读、Excel 往返、终态无残留容器，十一项全绿。
- [x] 真实门禁暴露并修掉三个只有容器才会暴露的缺陷：Docker 29 的 `local` 日志驱动 + `max-file=1` 与默认压缩冲突导致容器无法创建；结果目录用容器内 tmpfs 导致停机后回收为空（改为可写 bind 挂载 + Worker 监视 128 MiB 上限）；结果目录权限不允许容器固定 UID 写入。
- [x] 修掉网站 → Executor 客户端在 workerd 下必然失败的问题：workerd 不支持 `redirect: 'error'`，改为 `redirect: 'manual'` 并自行拒绝 3xx。
- [x] 在香港那台服务器上用并行实例（端口 3100，不碰线上 3000）跑通完整链路：task capability → 上传 → Agent 调用 `run_python` → 真实容器执行 → 产物发布 → 网站鉴权下载；并验证失败场景（非零退出 + 模型谎报成功被诚实性兜底替换）和超时场景如实报告、零产物。
- [x] 能力扩展第一步：输入新增 `.xlsx` 工作簿与 `.png` / `.jpg` 图片（上传时文本类按 UTF-8、二进制类按魔数校验），产物新增 `.xlsx`；XLSX 产物在第二个一次性容器里用 openpyxl 完整解析并拒绝宏。镜像增加固定版本 openpyxl，真实门禁扩到十一项，含「写 Excel → 校验发布 → 回读 Excel」闭环，全部通过。
- [x] 使用端接上 Python 通道：聊天框新增附件（按钮 + 拖拽到输入框 + 粘贴截图），支持 CSV/JSON/TXT/XLSX/PNG/JPG 并做前后端一致的限额校验；带附件的一轮会新建任务、把文件上传成受控 `file_id`、调用 `/api/python/agent`，回复里展示尝试次数/终态，产物可直接下载、图片内联预览。附件规则有独立单测，构建与类型检查通过。
- [x] 已发布到香港生产环境（`urtoris.cn`）：网站代码经 GitHub Actions 校验后部署到 `43.132.210.43`；Python Executor 以 systemd 服务 `urtoris-python-executor` 常驻 loopback `127.0.0.1:3010`（专用账号 + docker 组、生产模式、镜像按内容 ID 固定、启动探针核验容器真的被 LSM 与 seccomp 限制）；网站 `.dev.vars` 配置了独立的 `PYTHON_EXECUTOR_TOKEN`、`PYTHON_TASK_SIGNING_KEY` 并打开 `PYTHON_AGENT_ENABLED`。
- [x] 生产端到端验证：CSV 与 PNG 都能通过网站上传成受控 `file_id`，Agent 在真实受限容器里运行 Python 并发布 `summary.csv`（下载内容 `rows,total / 3,600` 与输入一致）；失败场景中模型谎报成功被替换为如实结论且零产物。界面附件代码已确认打进线上客户端 chunk（`workflow-lab-*.js` 含附件按钮）。
- [x] 纯文字的「生成 PDF / Word / PPT / Excel 等文件」请求在自动模式下会直接路由到执行 Agent；模型只返回命令时编排器会要求其重新提交 `run_python`。产物新增 PDF，用 ReportLab 生成、pypdf 隔离校验并在聊天中提供下载。
- [ ] 发布流程已扩展为同步 `services/python-executor` 并重启执行器，但 `/opt/urtoris/python-executor/node_modules`（tsx）是首次安装时手工放的，执行器镜像也是在主机上本地构建的；换机或重装需要按 README 重现这两步。
- [ ] 使用端附件交互仍只做静态验证：附件按钮、拖拽、粘贴和产物预览需要在浏览器里人工点一遍；本轮新增的会话恢复与长任务台账已在本机浏览器验收，见 [`consumer-session-ui.json`](evidence/consumer-session-ui.json)。
- [ ] 后续扩展（逐项评审后再做）：受限文件操作（`list_files` / `read_file` / `write_file` / `rename` / `delete`，路径限定在 `output/`）、更大配额、预装库白名单（不做运行期 pip）、受控联网出口、Browser / Computer / 真机各自的新工具协议。
- [ ] 接入私有对象存储和到期清理器；当前隔离预生产实现使用 Worker 私有本地目录。
- [ ] 补 CPU time 的真实采集与网页运行详情 UI；峰值内存采集已在本机长任务证据中落地。
- [ ] 正式部署：把网站与 Executor 部署到香港那台服务器（顺序是先把 Executor 装成 systemd 服务、镜像按 digest 固定、写入独立 token 与 signing key，再让网站通过 CI 发布），并在此之前保持 `PYTHON_AGENT_ENABLED` 关闭。
- [ ] Agent 的模型服务尚未在生产验证：当前只在本地 stub 上验证过工具调用链路；正式启用前需要用真实模型 Key 复核一次。
- [ ] 网页运行详情还缺「每次尝试的源代码」入口：执行器只在私有存储里保留 `source/main.py`，尚未提供受控读取接口，也没有按任务查看代码/日志的前端页面。
- [ ] 工具调用目前只在 OpenAI 兼容协议（`openai-chat`）上实现；Anthropic Messages 与 Gemini 的 tool 编码尚未实现，遇到这两类服务商一律 fail closed。
- [ ] 生产不开放 Shell / Browser / Computer / Robot Executor；本机当前用户 Shell 已作为机主专用模式落地。

## P0：网站安全补丁生产闭环

- [x] 发布前备份 ECS 上的网站源码、D1 持久化目录、`.dev.vars`、Nginx 与 systemd 配置
      （2026-09-11 完成，`/root/backup-20260911-195258/`，另含 `node_modules` 硬链接副本）。
- [x] 确认生产 `.dev.vars` 配置了彼此独立的 `URTORIS_ADMIN_TOKEN`、`URTORIS_API_TOKEN`、
      `N8N_BASE_URL`、`N8N_WEBHOOK_TOKEN`；本次补齐了缺失的 `URTORIS_ADMIN_TOKEN`
      （服务器生成，未外泄）；如使用额外浏览器 Origin，再配置 `URTORIS_ALLOWED_ORIGINS`。
- [x] 使用低内存安全构建流程部署本次网站代码（`deploy/rebuild-safe.sh`），未改动或升级生产 n8n；
      部署前先 `npm ci`（线上缺 Studio 依赖，且必须先停 n8n 腾内存）。
- [x] 在生产 D1 应用 `0006_security_guardrails.sql`（同时补上 `0007` / `0008`），
      历史 `n8n_auth_header` 列已删除且工作流数据未受损（7 行 workflow 在）。
- [x] 重启网站服务，网站与 n8n 均为 active，`GET /api/state` 200 且带 `Cache-Control: no-store`。
- [x] 验证 `POST /api/workflows`：无令牌返回 401（修复前是 503）。
- [ ] 校验正确管理员令牌可以创建 / 保存 / 发布工作流，以及错误令牌同样是 401。
- [ ] 验证 `/api/state` 公开 DTO：不包含 `n8nAuthHeader`、用户消息原文、内部日志、session/request/execution 关联标识或内部错误详情。
- [x] 验证跨站请求被拒（`POST /api/runs` 带 `Origin: https://evil.example` → 403）；
      `/api/agent/chat` 的跨站与无令牌分支仍待验证。
- [x] 验证请求体上限：普通执行接口 40 KB → 413（同源浏览器来源）；
      管理接口 64 KB 上限与分块请求仍待验证。
- [ ] 验证限流：`/api/runs`、`/api/agent/chat`、`/api/workflows` 和 `/api/v1/run` 超限后返回 429 与 `Retry-After`。
- [ ] 验证站点 n8n 目标双层白名单：只有配置的 n8n origin 和 `/webhook/urtoris/*` 可通过；跨 origin、带凭据、带 query/hash、编码穿越、反斜杠和空目标均被拒绝，且未向目标发起请求。
- [ ] 评估是否仍需在公开工作流 DTO 中返回 `n8nWebhookUrl`；当前它不含鉴权令牌且服务端有白名单校验，但如浏览器不再需要编辑，可改为仅返回脱敏状态或完全隐藏。
- [x] 公网入口切到站点：IP 默认入口由 n8n 改为 Urtoris 站点，`/webhook/` 仍转发给 n8n
      （限流与请求体上限保留）；n8n 编辑器不再暴露在公网。HTTPS/域名仍被未备案拦截。
- [x] 修复 HTTP 部署下的致命前端缺陷：`crypto.randomUUID` 与 `navigator.clipboard`
      只在安全上下文可用，公网 `http://IP` 下会让 Studio / 使用端整页崩溃；新增
      `lib/random-id.ts` 兜底并替换 4 处调用点。
- [ ] 重新运行 W1 并发、W4 安全 canary、生产只读检查器和 n8n audit，确认原有 7/7 active、
      requestId/executionId 映射和终态数据没有回归（公网 W1 单次调用已验证 completed / rules / degraded）。

## P1：n8n 升级验证

- [ ] 克隆生产 n8n 数据库和配置，建立隔离的升级测试环境。
- [x] 在本机完全隔离的数据目录运行 n8n 2.38.6（11 个工作流全部发布），未升级生产。
- [x] 从独立的 `origin/toolchain` worktree 重新生成 11 个工作流并复跑离线门禁：
      结构 11/11（140 节点）、节点版本 19/19、提前绑定 72/72、mode/degraded 10/10，
      `deploy-n8n --dry-run` 通过；站点侧跨仓库 binding 契约 20/20 通过。
- [ ] 在生产数据克隆上运行数据库迁移、11 个工作流激活检查、W1/W4、安全审计、
      错误归一回归和终态观察窗口。
- [x] 初步验证 n8n issue #37040：`all` 下 40 条成功执行全部定稿；独立复制库同时
      设置全局和工作流级 `none` 后，执行 id 46–57 完成即删除，0 个永久 running。
      生产数据克隆上仍需复验，详见 [`CANARY_RUNBOOK.md`](CANARY_RUNBOOK.md) §7。
- [x] 写出克隆升级/回滚/30 分钟观察方案，并增加 fail-closed 只读检查器：要求显式
      clone 标记与 clone/canary 路径，核对 11 个 workflow、关键节点、保存策略、迁移表、
      指定 execution 终态和陈旧 `running`。见
      [`N8N_2_38_6_UPGRADE_PLAN.md`](N8N_2_38_6_UPGRADE_PLAN.md)。
- [ ] 在定稿 canary 通过前继续保持 `EXECUTIONS_DATA_SAVE_ON_SUCCESS=all`。

## P1：Qwen Key 完整矩阵

- [ ] 正确 Key：本机 OpenAI 兼容替身已验证模型执行成功、`mode=llm` 且结果与运行记录一致；
      仍需用一次性 Qwen Key 在克隆环境完成一次真实调用（测试默认跳过，不接受生产 Key）。
- [x] 错误 Key：自动化矩阵验证返回 `LLM_ERROR`、落失败 run、`degraded=false`，
      同 requestId 重放失败结果且不会再次调用模型，不静默伪装成功。
- [x] 断网：自动化矩阵验证返回 `NETWORK_ERROR`、落失败 run，不进入成功或规则降级分支。
- [x] 无 Key：W1 / W2 / W5 在真实 n8n 2.38.6 执行中均进入规则降级，标记
      `mode=rules`、`degraded=true`。
- [x] 异常响应格式：2xx 非 JSON 被归一为 `LLM_ERROR` 与失败 run，不会误报成功。
- [x] 站点直连模型并发矩阵：相同 requestId 只调用上游一次；不同 requestId/session
      分别落库；跨 session 复用 requestId 返回 409。
- [ ] 在 `origin/toolchain` 生成的 n8n `common-llm` 路径复跑正确 Key、错误 Key、断网、
      异常格式与并发矩阵；当前新增门禁覆盖站点直连模型路径，不能替代真实 n8n canary。

自动化入口与一次性 Key 操作见 [`QWEN_BYO_KEY_MATRIX.md`](QWEN_BYO_KEY_MATRIX.md)。

## Workflow Studio：第一阶段架构设计

以下事项来自 `docs/plans/2026.9.11计划.md`。设计评审已经通过，用户随后明确要求按计划实施；原计划文件继续作为决策归档，不再代表当前实施状态。

- [x] 通读代码库，输出 [`CURRENT_ARCHITECTURE.md`](CURRENT_ARCHITECTURE.md)。
- [x] 梳理现有节点、步骤、状态、工作流 API、Webhook、数据库、日志和 requestId 机制。
- [x] 设计独立 Internal Graph Schema，输出 [`WORKFLOW_SCHEMA.md`](WORKFLOW_SCHEMA.md)。
- [x] 定义 Workflow、Node、Edge、Port、配置、运行状态和执行结果字段。
- [x] 定义 main、model、memory、tool、true/false、subworkflow 等端口和连接约束。
- [x] 设计 AI Agent、Condition、Tool、Trigger、Database、HTTP、Robot Action 等节点模型。
- [x] 评估 React Flow / XYFlow 与现有组件的复用成本。
- [x] 输出 [`WORKFLOW_UI_DESIGN.md`](WORKFLOW_UI_DESIGN.md)，覆盖 Canvas、节点库、Inspector 和 Runtime UI。
- [x] 设计 `Internal Graph Schema ↔ n8n Workflow JSON` 双向 Adapter，列出不兼容点。
- [x] 输出 [`MIGRATION_PLAN.md`](MIGRATION_PLAN.md)，包含兼容、灰度、回滚和数据迁移策略。
- [x] 完成计划要求的 15 节分析报告，并为每项标注优先级和难度。
- [x] 人工评审上述文档，并收到明确实施指令。

## Workflow Studio：MVP 实施状态

- [x] 独立 `/studio` 路由、节点库、无限画布、拖拽、移动、缩放、选择与删除。
- [x] 多端口曲线连线、重复连接、端口容量、类型和循环校验。
- [x] Agent 的 Model / Memory / 多 Tool 连接。
- [x] Condition 的 true / false 分支。
- [x] Graph V1 类型、Node Registry、legacy projector 与服务端 validator。
- [x] Graph 草稿的 D1 add-only 表、管理 API、内容哈希与 revision 乐观锁。
- [x] Timeline / Input / Output / Log / Error、Duration、requestId 的第一版 Inspector。
- [x] 复用现有 `/api/runs` 触发既有发布绑定；只展示真实 run envelope，不把 Graph 投影伪装成节点遥测。
- [x] Graph 部署入口保持锁定；编译产物可预览/下载，但不会自动导入或激活 n8n；
      本地 Preview 的合成状态、耗时和输出均显式标注。
- [x] 紧凑布局保留完整编辑闭环：节点图标有可访问名称，Inspector 使用可打开/关闭的触控抽屉。
- [x] 连接不再是装饰：边上的标签按端口语义自动显示（分支 `true`/`false`、资源
      连接 `Model`/`Memory`/`Tools`），可点击选中并进入边 Inspector（source/target、
      kind、branch、label 可编辑、该连接自己的校验结果、删除）。
- [x] 连接运行态由真实遥测推导（`carrying` / `taken` / `untaken` / `error`），
      Condition 未走的分支画成虚线灰而不是跟着源节点一起变绿；**没有任何节点级
      观测时整张图保持默认态**，不把"没看见"画成"没走"（14 条单测）。
- [x] 失败原因从事件一路带到画布：站点现在认识 `workflow.error` / `run.failed`
      （全局错误处理器上报的形状），折叠时抽出 `code` / `message` / `detail` 并脱敏
      截断；节点卡片显示错误码 + 一句话，Inspector 显示完整 detail，来边显示 Reason，
      Timeline 记录原因。没有结构化字段时退回事件 message，绝不编原因。
- [x] 为 validator、projector、Graph API 409 冲突和 100 节点基线补自动化测试（128 条，`npm test`）。
- [x] 发布时写入不可变 `workflow_versions` 快照：草稿 revision 与发布 version 分离、
      发布失败不留半成品、旧版本保留用于一键回滚。
- [x] 实现 Graph → n8n JSON Adapter v1.1（9 种业务节点）、确定性节点 id、
      `workflow_node_bindings`、去凭据产物与 golden fixtures；不支持的节点明确拒绝。
      v1.1 为 Trigger 生成 Webhook body 展平节点，为每个 Output 生成 `urtoris.v1`
      信封节点，重绑定 Memory session 字段，并把 `fallbackPolicy=error`
      编译为 `onError=stopWorkflow`（有可执行 Code 测试守着）。
- [x] Studio 增加「编译预览 / 下载 n8n JSON / 发布快照 / 版本回滚」入口；
      画布变更后旧预览会立即失效，Deploy 仍然锁定。
- [x] 实现说明与 canary 流程：[`WORKFLOW_GRAPH_RELEASE.md`](WORKFLOW_GRAPH_RELEASE.md)。
- [x] 在本机隔离 D1 应用 `0007_workflow_graph.sql` 与 `0008_workflow_graph_publish.sql`，
      配置独立管理令牌并完成真实 HTTP 权限回归；生产数据克隆仍待单独执行。
- [ ] 克隆环境导入 Adapter 产物并通过 canary（重点：Webhook body 展平、
      Memory 会话隔离、Qwen 兼容端点、Condition 两分支信封与失败映射），通过前
      不解锁 Deploy、不改生产 n8n。
- [ ] 给 Graph Adapter 产物增加可部署的真实事件来源。当前产物只有业务节点与
      `workflow_node_bindings`，**没有** `execution.bound` 或逐节点 started/completed 上报；
      绑定表只能把收到的 n8n 节点反查成内部 nodeId，本身不会产生事件。因此仅把现有
      `compiled_json` 导入 n8n 仍无法让 Studio 画布按真实节点点亮。实施前需在“产物内
      确定性插桩”与“克隆侧读取 execution data 后转发”之间定案，并补 fail-closed、去凭据、
      Condition 双输出与错误节点映射测试。
- [ ] Graph 与旧 `WorkflowStep[]` 的原子双写/冲突策略（当前两条发布链路互不同步）。
- [ ] 导入 n8n 后回填 `workflow_versions.external_workflow_id`。
- [ ] 持久化并脱敏节点级 Input / Output / Log / Error 快照，补齐真实节点耗时。
- [x] 修正 6 个节点的无效 typeVersion（含 `toolHttpRequest`），并用读取 n8n 2.38.6
      已安装包得到的版本表增加 19/19 自动化门禁；未登记类型或列表外版本均报错。
- [x] 多家模型服务可选：注册表 `lib/llm/providers.ts`（通义千问 / OpenAI / DeepSeek /
      Kimi / 智谱 GLM / Claude / Gemini / 本机 Ollama / 自定义 OpenAI 兼容端点），
      站点直连按协议分发（OpenAI 兼容 / Anthropic Messages / Gemini generateContent），
      Studio 与使用端都能选，认不出的服务直接 400 而不静默兜底；详见
      [`LLM_PROVIDERS.md`](LLM_PROVIDERS.md)（18 条新测试）。
- [ ] 给新增的模型服务补一次真实端到端调用（各用一次性 Key，不接受生产 Key），
      确认各家 OpenAI 兼容端点在 n8n 绑定工作流里也按预期工作。
- [x] 把「辅助改图的 Agent」和「工作流里运行的 Agent」拆成两套配置并在界面上讲清楚：
      辅助 Agent 只填模型服务 + Key 即可用（Ollama 可留空；`POST /api/workflows/agent` 已按 BYO Key
      同源策略放行，不写库故不再要求 Admin token；跨站仍 403，非浏览器请求仍需 API 令牌），
      Admin token 只管保存草稿 / 编译 / 发布 / 回滚这些真正落库的动作。
- [x] 辅助 Agent 已形成网站内闭环：服务端只接受严格蓝图并重建端口/连线，
      编辑模式复用节点 id、应用后可一步撤销或在侧栏直接保存到 D1；新建模式由
      用户确认后创建工作流记录并保存 Graph 草稿。两种模式都不自动发布、激活或导入 n8n。
- [x] 本机 / 内网访问直接视为管理员会话：本地开发不必再粘贴 Admin token，Studio 一打开
      就载入 D1 草稿，Save / Compile / Publish 都可用（Deploy 仍锁定）。判定要求
      「Host 是 loopback/私网 + 代理链上没有公网地址 + 非同站请求」，所以公网 nginx 入口
      把 Host 伪造成 localhost 也进不来；生产可用 `URTORIS_ADMIN_TRUST_LOCAL=0` 关掉。
      见 [`OPERATIONS.md`](OPERATIONS.md) 与 `tests/admin-trust.test.ts`（7 条）。
- [x] 修掉两处会挡住「辅助 Agent」改图的老毛病：
      ① `legacyStepId` / `legacyStepKind` 属于 Studio 内部标记，现在既不会发给模型
      （`currentGraphForPrompt` 里剥离），模型回显或伪造也不会被采纳（编辑现有节点时原样保留）；
      ② 模型回显现有节点 config 时，只要值与现有一致就按"没改"放过，不再被配置白名单误杀
      （例如 legacy 投影里 Robot Tool 的 `implementation: "robot"`）。
      另外修正 legacy 投影：Output 是终点节点，其后不再连出"从不存在端口出发"的悬空边，
      Output 之后的旧步骤不投影到画布（仍留在 `draft_steps_json`）。

## P0 #3：真实运行事件管线（进行中）

已完成的部分（`lib/server/node-telemetry.ts` + `GET /api/runs/:requestId/telemetry`，
节点状态由 Studio 通过游标轮询消费，测试见 `tests/node-telemetry.test.ts`、
`tests/studio-telemetry.test.ts`、`tests/studio-telemetry-contract.test.ts`）：

- [x] 通过 `workflow_node_bindings` 把 n8n 节点（id 或名字）解析回内部 nodeId；
      解析不到时返回 `null` 并进 `unmappedNodes`，绝不猜一个 id 出来。
- [x] 节点状态由事件折叠得出（waiting / running / success / error / skipped），
      没有事件就是 waiting；终态不被后到的 running 降级，冲突会计数。
- [x] 事件按 `rowid` 游标增量读取：断线重连只补没拿到的，不重复不丢。
- [x] payload 脱敏（凭据字段 → `[redacted]`）+ 截断 + 分页上限，转义后也不会超限。
- [x] 测试矩阵：两 workflow 并发、同 workflow 两 requestId 并发、节点失败、
      事件乱序（两种）、映射缺失、游标重连、executionId 精确绑定优先于 ±2 分钟时间窗、
      同 requestId 重试不重复触发副作用。

还没做（P0 #3 的剩余部分）：

- [x] 5 个业务工作流在协议校验后、危险节点前建立 `requestId ↔ executionId`；
      绑定必须得到 2xx + `{ok:true,bound:true}` 才放行，缺 requestId 不上报，网关
      保持 legacy。真实 n8n 已验证正确绑定与错误令牌 fail-closed。
- [x] legacy 网关在转发前把短 key 归一成站点 `wf_n8n_*` id，并把 HTTP 成功/错误
      两个输出都接入响应归一，避免目标绑定 404 或 HTTP 200 空 body。
- [x] Studio 接上这套接口：节点状态改为轮询
      `/api/runs/:requestId/telemetry?afterSeq=`（游标翻页 + 定稿后确认空页），
      没有事件就保持 idle，运行结束不再播放"主路径动画"；`unmappedNodes`、
      绑定来源、事件数与节点计数在运行面板显示，节点级日志进入 Timeline。
      折叠规则抽成 `lib/workflow-graph/telemetry.ts`：终态不回退、分页不降级、
      未映射节点跨页累积，9 条单测 + 2 条契约测试（真实 SQL + 真实路由）守着。
- [ ] SSE 版本（目前是游标轮询；SSE 可以在同一数据源上薄封装）。
- [ ] `run_node_states` 物化表（当前是按需从 `n8n_events` 折叠，读多写少时再考虑）。
- [ ] 在带真实 n8n 的克隆环境里用浏览器点一次 Run，确认画布按真实事件点亮、收尾
      不被空页熄灯（当前这几条只有纯函数单测、契约测试与构建验证）。
- [x] 本机隔离 n8n 2.38.6 验证真实事件链路：`execution.bound`、精确映射、
      `run.completed/run.failed`、游标断线重拉、未映射节点与 fail-closed 均有实证。

## 使用端值班簿：收尾评审（2026-09-14）

- [x] 使用端条目、页眉戳记、记录页与本次办理联页按「值班交接簿」重建
      （`d1a8f0e`），结构、状态语言与响应式规则写进
      [`CONSUMER_LEDGER_SURFACE.md`](CONSUMER_LEDGER_SURFACE.md) 与
      [`DESIGN.md`](../DESIGN.md) 的 Surfaces 一节。
- [x] 收尾评审修掉五类问题并单独提交（`3e01d18`）：设置页改成原生
      `<dialog>.showModal()`、加号菜单补齐 `fieldset`/`aria-pressed`/Esc 还焦点、
      运行台账状态戳中文化、长工作流名截断、821–1120px 不再把工作端压成三列。
- [x] 浏览器实测（本机 headless Chrome，1440/1120/1024/900/390）：横向溢出全为 0；
      设置页 `:modal` 为真、Esc 关闭且焦点归位；模拟运行跑完 5 步闭环并在运行台账
      留下一行「已完成」。原始数据见
      [`evidence/consumer-ledger-review.json`](evidence/consumer-ledger-review.json)。
- [ ] 使用端仍只做过模拟执行与静态验证：带真实 n8n 的克隆环境里，用浏览器点一次
      Run 确认画布与记录页按真实事件点亮（与 P0 #3 同一项）。
- [ ] 后续想去掉评审用的本地脚手架（`.impeccable/`、`work/rootcheck/`）时，
      记得先确认 `docs/evidence/consumer-ledger-review.json` 已经能独立复现结论。

## 暂不纳入本轮提交的动作

- 不部署生产。
- 不升级生产 n8n。
- 不填写或提交任何真实 API Key、管理员令牌或 Webhook 令牌。
- 不对现有工作树执行 reset、checkout 或覆盖式清理。
