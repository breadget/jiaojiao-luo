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
