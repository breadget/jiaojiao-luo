# ADR 001 — Graph runtime 的事件来源

日期：2026-09-12，更新 2026-09-13。状态：选择 B，真实执行及回滚已验证；
最终检查结果见 [本轮证据](evidence/graph-runtime-canary.json)，不是生产启用批准。

## 决策

采用 **B：克隆侧 execution-data forwarder**，读取已保存的真实执行快照。
另在产物入口生成确定性的同步 HTTP `execution.bound` 守卫。这是 B 的必要
前置屏障，不能由事后读取数据库替代；不把守卫冒充为完整的节点事件来源。

| 方案 | 优点 | 限制 |
| --- | --- | --- |
| A：业务节点前后插入事件节点 | 主链 started 可以及时送达；HTTP 节点可以挂 Header Auth | Agent 的 model/memory/tool 是 AI 子连接，主链包裹节点不能证明子节点调用；stopWorkflow 后普通后继不会执行；需要额外错误路径，改变 Graph 控制流 |
| B：执行数据转换 | n8n 自己记录节点名称、运行索引、开始时间、耗时、错误和实际输出口；无需伪造 AI 子节点调用 | 数据保存有延迟；崩溃可能没有完整快照；必须保留 all；仅靠它不能提前绑定 |

第一版转发**已定稿快照**，started 的时间来自 n8n，送达发生在快照持久化后。
这是执行事实回放，不承诺毫秒级实时 started。没有完整执行数据时保持 pending，
不按超时或 HTTP 200 推测 run.completed。Studio 必须等待事件源终态水位。

## 已核对的 2.38.6 事实与证据

- 固定版本 [2.38.6 源码](https://github.com/n8n-io/n8n/tree/n8n%402.38.6)。
- [execution-lifecycle-hooks.ts](https://github.com/n8n-io/n8n/blob/n8n%402.38.6/packages/cli/src/execution-lifecycle/execution-lifecycle-hooks.ts)
  有 nodeExecuteBefore / nodeExecuteAfter；Editor push 依赖 pushRef，不能把编辑器
  会话推送当作生产 Webhook 的通用事件 API。保存与状态定稿是独立 lifecycle hooks。
- [执行配置](https://docs.n8n.io/hosting/configuration/environment-variables/executions/)
  提供成功、失败及进度保存选项。本方案要求成功和失败 all，不依赖默认值。
- npm 安装与运行的本轮证据、精确包版本、源码文件 hash、Canary 结果另存验收报告；
  旧 runbook 的历史成功不计作本轮通过。源码存在不等于本轮运行成功。
- 实际 n8n 包为 2.38.6，其 core / nodes-base / langchain 依赖为 2.38.2，不能把外层
  版本号误当成所有节点包版本。SupplyDataContext 为模型和 Memory 记录真实 runData，
  包括 startTime、executionTime、executionStatus 和 error；本轮真实 Agent 执行已读到这些数据。
- Simple Memory 1.4 的实际隔离键是 workflowId + sessionId。相同 session 的第二次模型调用
  带前次用户消息，不同 session 不带；不保证重启持久化或队列多 worker 隔离。
- Webhook 2 除 parameters.path 外还需要 webhookId；缺失时实际注册了带节点前缀的路径，
  目标 Webhook 返回 404。现在 webhookId 与外部节点 ID 一起确定性生成，真实导入后路径正常。
- publish:workflow 支持 --versionId；本轮已从 Graph v3/n8n 当前历史版本切回 v2，重启、
  执行两分支、核对 boundVersion，再恢复 v3 并重测。全过程不覆盖历史。

## 顺序、隔离与幂等

入口：Webhook → 展平/校验 → execution.bound HTTP → 严格确认 → 业务节点。
只有 HTTP 200 且 ok===true、bound===true 放行；网络异常、无凭据和其他响应停止。
workflowId 来自编译参数，不能被请求覆盖；executionId 来自 n8n 的 $execution.id。

绑定固定 graph version，后续发布/回滚不改变旧 execution 的映射。站点按
requestId、executionId、workflowId 三元组验收事件；源内单调 sourceSeq 从 0 的
execution.bound 开始。收据与事件在 D1 batch 内一起写入；相同序号同内容重传幂等，
同序号不同内容、缺号、跨 workflow 冲突返回 409。转发者逐条等 ACK 后发送下一条，
重启从持久快照重新转换，利用站点收据恢复，不用时间窗认领 Graph execution。

业务节点只使用 workflow_node_bindings 映射。辅助节点不能提前将业务节点标为成功。
未映射节点进入 unmappedNodes。Condition 依据执行数据中实际输出口与执行节点集合，
仅在完整终态下记录未执行节点 skipped；不把两个出口都记为 success。
重试可能产生多个真实 executionId；遥测按 run 最终关联的 executionId 查询，避免前一次
失败的终态盖住后一次执行。重复模型/Memory 调用按同一个外部节点聚合，任何一次失败
都不能被该节点先前的 success 掩盖。终态后新增事件拒绝，客户端折叠也禁止 success 回退。

接口采用公开约定的 node/name 或外部 ID，不从 `U::...` 名字反解析内部 nodeId。
sourceSeq 是转发流序号，afterSeq 是 D1 持久事件游标；两者不是同一个计数器。
started 的历史时间可能早于绑定 HTTP 时间，但绑定永远是第一条被接纳的事件，且守卫在
任何危险节点之前拿到 ACK。无完整快照时，可能只有 execution.bound，没有终态，这是诚实的 pending。

## 失败与生产关闭

n8n error/crashed/canceled 只产生失败；缺失执行数据不能产生成功。run.completed
还须有合法 urtoris.v1 成功信封；缺信封即失败。错误只转发允许的 code/message/detail，
在离开克隆进程和站点落库前脱敏，不传输入、模型提示、鉴权头或完整堆栈。

无 Key 是显式编译配置：`credentialRef=none` 必须与 `fallbackPolicy=rules` 一起使用。
这时 Agent 生成规则结果 `reason=LLM_NOT_CONFIGURED`，envelope 为 rules/degraded=true，
model/Memory 不连接、不调用，并通过确定性 manifest 标 skipped。已声明 credentialRef 却
没挂载、401、TCP 断开或异常 JSON 都停止执行；不存在在运行错误后伪装规则成功的兜底。
本轮缺挂载的额外探针也实际报错；替身成功用随机本地凭据，未使用或访问生产模型 Key。

运行入口有显式 Canary 开关，未启用返回 503。forwarder 要求 clone marker、固定版本、
工作流允许清单、只读 SQLite、loopback 站点地址。Deploy 保持 Adapter locked。
本轮验证采用原生 n8n 执行、真实本地 D1/HTTP、Headless Edge 的 Studio DOM；模型为
允许的本地替身，未声称做过 DashScope 云端可用性验收。11 个旧工作流已导入/激活，
业务执行矩阵针对 Graph。生产离线数据迁移、外部数据库/队列模式、进程监督与容量仍
没有验收证据，即使本轮克隆通过也保持生产开关关闭。
