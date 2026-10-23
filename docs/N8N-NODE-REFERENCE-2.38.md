# n8n 2.38.6：本轮 Adapter 节点与运行能力核对

本轮实际安装外层 n8n@2.38.6，依赖 n8n-core、n8n-nodes-base、
@n8n/n8n-nodes-langchain 均为 2.38.2。运行包版本与源文件 SHA-256
在 [机器可读证据](evidence/graph-runtime-canary.json) 的 runtime 字段。
官方固定版本入口：[n8n@2.38.6](https://github.com/n8n-io/n8n/tree/n8n%402.38.6)。

| 产物节点 | typeVersion | 核对结果 |
| --- | --- | --- |
| Webhook | 2 | body 在 $json.body；必须设置确定性 webhookId 才获得预期注册路径 |
| Code | 2 | 输入校验、严格绑定守卫、规则路径和 envelope；真实 JS runner 已执行 |
| HTTP Request | 4.2 | Header Auth + fullResponse + neverError，守卫检查真实 statusCode/body；禁跟随重定向 |
| If | 2.2 | main[0] 为 true、main[1] 为 false，真实空输出口可证明未选分支 |
| Agent | 3.1 | text 是用户输入，systemMessage 是系统指令；错误停止，不能规则降级 |
| OpenAI Chat Model | 1.3 | model 为 resourceLocator；responsesApiEnabled=false，走 /chat/completions |
| Window Memory | 1.4 | customKey 明确引用归一化输入的 sessionId；实际内部键包含 workflowId |
| HTTP Tool | 1.1 | 本轮确认节点版本表；未实际发送工具业务请求 |
| Respond to Webhook | 1.5 | 接收前置 Code 的完整 urtoris.v1 envelope，两分支均真实返回 |

Adapter 1.2.1 继续使用 Code 2，将终端 JSON 的 `context.input` 业务字段展平到输入接口，并从其中补齐 `question`；外层请求和生成的协议字段优先，业务字段不能覆盖链路标识。已同步 Canary 编译夹具与哈希，离线契约测试覆盖字段保留与优先级。本次网站发布不会自动替换既有 n8n 工作流绑定。

[执行 lifecycle 源码](https://github.com/n8n-io/n8n/blob/n8n%402.38.6/packages/cli/src/execution-lifecycle/execution-lifecycle-hooks.ts)
存在 nodeExecuteBefore / nodeExecuteAfter。Editor push 依赖 pushRef，本轮未把它当作通用 Webhook 事件 API。
安装包的 SupplyDataContext.addExecutionDataFunctions 确实给 AI 子节点写入 startTime、
executionTime、executionStatus 与 error；真实 Agent 的 model/Memory runData 已逐项读取验证。

本轮读取 SQLite execution_entity + execution_data，以安装包自身 flatted 解码。
只转换 success/error/crashed/canceled 且 stoppedAt 非空的已保存快照。
实际 `publish:workflow --id --versionId` 支持历史版本切换，并要求主进程重启后生效。
这两项均有真实执行/回滚证据，不能仅根据版本号推定兼容。

尚未验证生产 PostgreSQL、queue/多 worker、云端 DashScope 或生产离线备份升级。
Simple Memory 不跨重启持久，不将本机会话隔离外推到集群。
