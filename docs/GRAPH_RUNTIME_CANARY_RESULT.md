# Graph Runtime Canary 验收记录

基线 `origin/main@0f14948`，独立分支 `codex/graph-runtime-canary`。
本文件只汇总可读结论，最终状态、精确执行 ID、版本和 SHA-256 以
[机器可读证据](evidence/graph-runtime-canary.json) 为准。

架构选择 B：真实 execution data 转换；入口另有确定性、同步、fail-closed 的绑定 HTTP 守卫。
完整取舍与 2.38.6 能力证据见 [ADR](ADR-001-GRAPH-RUNTIME-EVENTS.md)。
数据流实际经过本地站点 API → n8n Webhook → 校验/展平 → execution.bound ACK →
原生 Agent/Model/Memory/Condition → 持久化快照 → forwarder → D1 → Studio telemetry/画布。
started 是真实 n8n 时间的定稿后回放，不声称在节点运行的瞬间送达。

| 要求 | 本轮证据 |
| --- | --- |
| 真实引擎 | npm 分发 n8n 2.38.6 主进程与 JS runner；core/base/langchain 实际为 2.38.2 |
| 请求关联 | 实际 execution data 中 requestId/sessionId/question/channel/urgency 正确，workflowId 固定为站点 ID |
| 提前绑定 | 只有 200 且 ok/bound 为布尔 true 放行；五种拒绝状态实际停止在守卫，只有四个安全节点执行 |
| 幂等/隔离 | 实际 HTTP 重复 binding 200/duplicate；execution、workflow、session、version 冲突 409 |
| 模型成功 | 本地 OpenAI 兼容替身 + 随机测试凭据，原生 Chat Model/Agent 返回 llm/degraded=false |
| 模型失败 | 提供方 401、TCP 断开、异常 JSON 均真实失败，节点包含已脱敏 code/message/detail，出现 workflow.error 与 run.failed |
| 显式无 Key | credentialRef=none + fallbackPolicy=rules，rules/degraded=true，模型零调用，Model/Memory skipped |
| 缺失挂载 | 已声明模型引用却未挂凭据的额外探针真实报错；不能把配置错误偷偷当成规则成功 |
| Memory | 同一 session 的第二次模型消息带前次内容，另一 session 不带；sessionKey 非空且明确引用归一化输入 |
| Condition | high 只执行 true，normal 只执行 false；两出口都返回合法 urtoris.v1 信封 |
| 真实 unmapped | 导入漂移副本增加真实 Code 节点，出现在 unmappedNodes，没有猜内部 ID |
| 首次/分页 | 第一次读取包含 execution.bound 和终态；limit=3 完整分页与全部事件序列一致 |
| 实际转发中断 | forwarder 停止期间只有一条 binding，run 保持 running；恢复补回 14 条事件，终态 completed，不重不漏 |
| 乱序 | 终态后真实迟到 node.started 返回 409，success 不回退；自动化测试也覆盖终态前乱序折叠 |
| Studio | Headless Edge 读取真实本机 API，成功画布 6 success + 1 skipped；失败时 2 个红色节点，Inspector 显示 code/message/脱敏 detail；到达已定稿，Deploy disabled |
| 11 个 workflow | 既有家族全部导入、按依赖顺序 publish 并激活；不是 11 个业务流程全量业务验收 |
| 回滚 | 实际 v3 → v2 → v3，精确 n8n history versionId + 站点指针，重启后各跑 high/normal 并确认 boundVersion |
| 观察 | 仅最终完整 30 分钟、零陈旧 running 的窗口可通过；中断的 5 分钟窗口已作废 |
| 生产状态 | Canary flag 默认关闭，Deploy 仍 locked；未访问生产数据库/n8n/模型 Key |

自动化结果：`npm test` 共 291 项，290 通过，1 项原有可选真实云 Qwen Key 测试跳过。
本轮按授权使用本地替身，真实 n8n Canary 本身完整执行，没有用该跳过替代验证。
`npx tsc --noEmit`、`npx oxlint`、`npm run build` 都 exit 0。

核心产物（SHA-256；完整导入副本和源文件 hash 另见 JSON）：

- Golden compiledHash：`c31e2c9f82cd4eabd10843def790693cdd18d035d989ebb784bdacb3bec496a6`
- 实际 Graph v3 compiledHash：`fdf5c7ca21faa6005ad3f88b7ddb477f5c11e56f09fe6d63eb2589c9810b8c87`
- 无 Key Graph compiledHash：`8e11bf0ada5f4d8a30d7d10c40915fba936be34c6a57b0369e6f0f5b1aa553bc`

产物无内联凭据，同 Graph/workflowId/version 逐字节一致，失败不返回半成品。
迁移只新增 0009；原迁移和历史测试保留。Graph/WorkflowStep 原子双写范围未修改。

本轮隔离链路的最终阻塞项见 JSON 的 remainingBlockers；完成后应为空。
**生产启用仍有明确未完成项**：没有生产离线脱敏备份及原版本配置，因此未演练生产数据升级；
没有云 DashScope 可用性验收；尚未实现/验收 PostgreSQL、queue/HA、跨 worker 持久 Memory
和生产转发服务监督/容量。当前单机 SQLite 实现只能用于克隆环境。
需要外部提供的最小条件是运维准备的离线脱敏备份和版本/配置清单；下一步是在另一个
隔离环境恢复并重跑迁移、矩阵和观察，不连接生产。云 Key 不是本轮必需条件。

[完整复现与清理步骤](CANARY_RUNBOOK.md)。
