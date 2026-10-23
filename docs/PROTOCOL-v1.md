# Urtoris ↔ n8n 协议 v1

`urtoris.v1` 是网站、n8n 主工作流、公共子工作流和运行记录之间的唯一交换格式。

## 请求信封

```json
{
  "protocol": "urtoris.v1",
  "requestId": "abc123",
  "workflowId": "wf_example",
  "sessionId": "sess_example",
  "message": "用户输入",
  "user": { "id": "anonymous" },
  "context": {
    "input": {},
    "intentHint": "一般问题",
    "conversationHistory": [
      { "role": "user", "content": "先帮我把销售数据整理成表" },
      { "role": "assistant", "content": "已经整理成表，共 12 行。" }
    ],
    "llm": {
      "apiKey": "仅随当次请求透传",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "model": "qwen-plus"
    }
  },
  "meta": {
    "source": "urtoris-web",
    "sentAt": 1789020000000,
    "attempt": 1,
    "timeoutMs": 45000,
    "idempotencyKey": "abc123"
  }
}
```

`requestId` 在重试时保持不变，`meta.attempt` 递增。API Key 不写入网站数据库、n8n 凭据库或执行日志。

`context.conversationHistory` 是**同一个使用端会话里更早的完整轮次**（`user` / `assistant` 和完整正文），不再按 12 条、6000 字符或单条 1200 字符截断。正文还附带聊天框里保存的附件信息、生成文件信息和执行结果；附件信息不代表模型读取了文件内容。它来自网站已经落库的会话记录，用来补齐只靠 n8n Memory 覆盖不到的部分：同一个会话里更早的某一轮可能是 Python Executor 或本机 Control Agent 跑的，n8n 自己的 Simple Memory 看不到。数据库按游标分批读完，不再只返回最早 200 条。

浏览器请求携带 `consumerSessionId`（Python / 本机执行入口使用 `sessionId`）和 `userMessageId`。服务端校验会话归属，按当前用户消息的编号确定历史边界，排除当前轮占位消息；重复发送的相同文字仍作为独立轮次保留。历史读取失败会明确返回错误，不静默当成新对话。完整上下文超过所选模型的上下文窗口时，模型服务的错误会回传给用户，不自动删除旧消息。

普通聊天还携带 `agentMessageId` 和稳定的 `requestId`；占位消息保存 `metadata.chatRequestId`。
服务端在返回 HTTP 回复前保存对应消息的正文和终态，浏览器收到结果后立即展示，不额外播放
日志延迟。会话读取会按该 requestId 从同工作流、同 engineSessionId 的已保存运行恢复丢失的
回复，不重新调用模型；超过 120 秒仍没有结果的占位会明确报错。客户端轮询不能覆盖读请求
之后开始的消息写入或已返回的最终回复，请求头和 JSON 正文读取都有超时限制。

- 它是**上下文，不是执行证据**：里面的 assistant 内容不代表这次 n8n 执行做过什么，工作流不得据此声称"已经生成/已经执行"。
- `context.conversationHistory` 缺省表示该会话没有更早的轮次（例如纯 API 调用、第一轮，或调用方没有带 `consumerSessionId`）。这种情况下工作流应当只回答当前 `message`，不要凭空补历史。
- Memory 节点仍然按 `sessionId` 分区工作；两者可以同时存在，工作流不要把同一段历史打印两遍。

## 响应信封

```json
{
  "protocol": "urtoris.v1",
  "success": true,
  "requestId": "abc123",
  "engine": "n8n",
  "mode": "rules",
  "degraded": true,
  "workflow": "wf_example",
  "data": {},
  "error": null,
  "meta": {
    "executionId": "772",
    "durationMs": 128,
    "attempt": 1,
    "httpStatus": 200
  }
}
```

- `engine`：承载执行的引擎，可为 `n8n`、`model` 或 `simulated`。
- `mode`：真正走的业务能力，可为 `llm`、`rules` 或 `simulated`。
- `degraded`：是否在成功返回时使用了降级能力。W1/W2/W5 无 Key 走规则时必须为 `true`。
- `success`：只表示工作流完成，不代表 LLM 已运行。

真实模型成功时必须返回 `mode=llm, degraded=false`。错误响应保持相同外层形状，仅将 `success` 设为 `false`、`data` 设为 `null`，并填写 `error`。

## 确定性执行映射

n8n Webhook 收到请求后，必须在校验、LLM、HTTP 或 Tool 节点前上报：

```json
{
  "eventType": "workflow.started",
  "requestId": "abc123",
  "executionId": "772",
  "workflowId": "wf_example",
  "workflow": "W1 · Agent LLM 连通性冒烟",
  "sessionId": "sess_example"
}
```

网站将它写入 `n8n_execution_map`。错误回调先按 `executionId` 精确反查 `requestId`；只有历史工作流未上报映射时，才使用“同一工作流 + ±2 分钟”兼容逻辑。

## 安全边界

- 网站 → n8n：`Authorization: Bearer <N8N_WEBHOOK_TOKEN>`。
- n8n → 网站事件入口：`Authorization: Bearer <URTORIS_INTERNAL_TOKEN>`。
- 全链路同时携带 `x-urtoris-request-id` 和 `x-urtoris-session-id`。
- 日志中不得记录 API Key、Authorization 头或原始凭据。
