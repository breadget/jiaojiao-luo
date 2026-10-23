# Urtoris ↔ n8n 统一协议 v1

> 网站调用任意 n8n 工作流时，**只依赖这一份契约**。网站不需要知道工作流内部有几个节点、用了什么模型、连了哪些外部 API。

- 协议标识：`urtoris.v1`（请求体与响应体的 `protocol` 字段，双方必须校验）
- 传输：`POST` + `Content-Type: application/json`
- 入口：`http(s)://<n8n>/webhook/urtoris/<workflow>`
- 鉴权：请求头 `Authorization: Bearer <N8N_WEBHOOK_TOKEN>`
- 编码：UTF-8，请求体上限 32 KB，响应体上限 256 KB

---

## 1. 请求信封（网站 → n8n）

```json
{
  "protocol": "urtoris.v1",
  "requestId": "4a1c2f7e-3b9d-4c1a-8f2e-5d6a7b8c9d0e",
  "workflowId": "customer-service",
  "sessionId": "sess_9f3c1a2b",
  "message": "我的订单为什么还没到？",
  "user": { "id": "user001" },
  "context": {
    "llm": {
      "apiKey": "sk-***",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "model": "qwen-plus"
    }
  },
  "meta": {
    "source": "urtoris-web",
    "sentAt": 1789009042620,
    "attempt": 1,
    "timeoutMs": 45000,
    "idempotencyKey": "4a1c2f7e-3b9d-4c1a-8f2e-5d6a7b8c9d0e",
    "workflowVersion": 7,
    "workflowName": "客服问题分流",
    "steps": [{ "index": 1, "id": "step-1", "title": "接收问题", "kind": "input", "detail": "收集用户的原始问题" }]
  }
}
```

### 字段约束

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `protocol` | string | 是 | 固定 `urtoris.v1`，不是这个值一律 `VALIDATION_ERROR` |
| `requestId` | string | 是 | UUID v4，**全链路贯穿**：网站 → n8n → 子工作流 → Tool → 数据库 → 日志 |
| `workflowId` | string | 是 | 业务标识（站点侧的工作流 id 或约定的逻辑名） |
| `sessionId` | string | 是 | 多轮会话标识，同一会话内保持不变；`common-memory` 用它做记忆分区 |
| `message` | string | 是 | 用户输入，≤ 2000 字 |
| `user` | object | 否 | 至少含 `id`；其余字段原样透传，n8n 不做假设 |
| `context` | object | 否 | 自由上下文。**`context.llm` 是唯一的模型配置入口**（BYO Key） |
| `meta` | object | 是 | 见下 |

### `context.llm`（BYO Key，n8n 永不落盘）

网站把用户自己填的模型配置**按请求透传**，n8n 端不保存任何模型密钥：

```json
{ "apiKey": "sk-***", "baseUrl": "https://.../v1", "model": "qwen-plus" }
```

- 缺 `apiKey` → `common-llm` 返回 `LLM_NOT_CONFIGURED`，工作流**不得**崩溃，由业务节点决定降级策略。
  W1 / W2 / W5 会转入规则兜底并返回成功信封，同时明确标记
  `mode: "rules"`、`degraded: true`；真实模型路径标记
  `mode: "llm"`、`degraded: false`。
- `baseUrl` 缺省 `https://dashscope.aliyuncs.com/compatible-mode/v1`，`model` 缺省 `qwen-plus`。
- 密钥只存在于本次请求内存与 n8n 执行数据中；**生产环境请对执行数据开启清理**（见 `OPERATIONS.md`）。

### `meta` 字段

| 字段 | 说明 |
| --- | --- |
| `source` | 调用来源，如 `urtoris-web` / `urtoris-api` |
| `sentAt` | 毫秒时间戳 |
| `attempt` | 第几次投递，从 1 开始；**重试时 `requestId` 不变，只递增 `attempt`** |
| `timeoutMs` | 调用方等待上限，n8n 端应在超时前返回 |
| `idempotencyKey` | 默认等于 `requestId`；下游去重依据 |

---

## 2. 成功响应信封（n8n → 网站）

```json
{
  "protocol": "urtoris.v1",
  "success": true,
  "requestId": "4a1c2f7e-3b9d-4c1a-8f2e-5d6a7b8c9d0e",
  "engine": "n8n",
  "mode": "rules",
  "degraded": true,
  "workflow": "customer-service",
  "data": {
    "message": "已识别为物流问题，最新节点：杭州转运中心。",
    "intent": "订单与物流",
    "priority": "中"
  },
  "error": null,
  "meta": {
    "executionId": "412",
    "durationMs": 1284,
    "attempt": 1,
    "startedAt": 1789009042701,
    "finishedAt": 1789009043985
  }
}
```

## 3. 失败响应信封（n8n → 网站）

失败**也必须是同一个形状**，`success=false`、`data=null`、`error` 非空：

```json
{
  "protocol": "urtoris.v1",
  "success": false,
  "requestId": "4a1c2f7e-3b9d-4c1a-8f2e-5d6a7b8c9d0e",
  "engine": "n8n",
  "workflow": "customer-service",
  "data": null,
  "error": {
    "code": "LLM_TIMEOUT",
    "message": "模型响应超时",
    "detail": "dashscope 在 30000ms 内未返回",
    "node": "common-llm",
    "retryable": true
  },
  "meta": { "executionId": "413", "durationMs": 30041, "attempt": 1 }
}
```

### 错误码表（闭集，网站按码分支）

| code | 含义 | retryable | HTTP |
| --- | --- | --- | --- |
| `VALIDATION_ERROR` | 请求体不符合协议 | 否 | 400 |
| `UNAUTHORIZED` | 缺少/错误 Bearer Token | 否 | 401 |
| `FORBIDDEN` | Token 有效但无权调用该工作流 | 否 | 403 |
| `NOT_FOUND` | workflowId 不存在 | 否 | 404 |
| `BINDING_FAILED` | 执行前未能把 requestId 绑定到 executionId（危险节点一律未执行） | 是 | 200/503 |
| `RATE_LIMITED` | 触发限流 | 是 | 429 |
| `TIMEOUT` | 整个工作流超时 | 是 | 504 |
| `NETWORK_ERROR` | 网络不可达 / DNS / 连接被拒 | 是 | – |
| `UPSTREAM_ERROR` | 下游服务返回错误 | 是 | 502 |
| `UPSTREAM_TIMEOUT` | 下游服务超时 | 是 | 504 |
| `CREDENTIAL_MISSING` | 需要外部凭证但未配置 | 否 | 424 |
| `LLM_NOT_CONFIGURED` | 请求未携带 `context.llm.apiKey` | 否 | 424 |
| `LLM_ERROR` | 模型返回错误 | 是 | 502 |
| `LLM_TIMEOUT` | 模型超时 | 是 | 504 |
| `NODE_ERROR` | 单个节点抛错 | 视情况 | 500 |
| `INTENT_UNKNOWN` | 无法识别意图 | 否 | 422 |
| `INTERNAL_ERROR` | 未归类的内部错误 | 是 | 500 |

### 前置执行绑定（`execution.bound`）

**5 个业务工作流**（`wf_n8n_llm_smoke` / `wf_n8n_user_manager` / `wf_n8n_security_analysis` /
`wf_n8n_api_gateway` / `wf_n8n_customer_insights`）在 **请求校验通过之后、任何危险节点
（LLM / HTTP / Tool / Robot Action）之前** 都会先向 `POST /api/n8n/events` 报一条事件。
节点顺序固定为：

```
Webhook → 校验请求 → 请求合法? ─┬─ true  → 绑定执行 (execution.bound) → 归一绑定结果 → 绑定成功? ─┬─ true  → 业务节点
                              │                                                                  └─ false → Respond（BINDING_FAILED）
                              └─ false → 组装错误 → … → Respond（VALIDATION_ERROR）
```

```json
{ "requestId": "4a1c2f7e-…", "executionId": "413", "workflowId": "wf_n8n_llm_smoke",
  "triggerNodeId": "webhook-26", "eventType": "execution.bound" }
```

- `requestId` 直接取校验结果（`校验请求` 节点）里的 `requestId`，该节点已经判过它非空、
  **没有兜底值**；`workflowId` 取请求体里的 `workflowId`，即**站点侧**的工作流 id（`wf_n8n_*`），
  不是 n8n 侧的工作流 id。
- **`requestId` 缺失的请求不会调用本接口**：它在上一步的校验闸门就被判成
  `VALIDATION_ERROR`（false 分支 → 组装错误），既不会污染绑定表，也不会把错误码错报成 `BINDING_FAILED`。
- 站点返回 `{ "ok": true, "bound": true, ... }` 才放行进入业务节点；
- 站点返回非 2xx、`ok !== true`，或根本连不上 → 工作流立刻以
  **`success:false` + `error.code = "BINDING_FAILED"`** 的信封响应，**不执行任何危险节点**（fail-closed）。
- 生成的工作流在 `meta.urtorisBinding` 里声明自己属于哪种：
  `prebound` = 有这道闸门（当前 5 个业务工作流）；
  `legacy` = 不参与前置绑定（当前 6 个：4 个 `common-*` 子工作流、全局错误处理、
  以及 **`urtoris-gateway`**），站点不要假设它已经绑定过。
  `urtoris-gateway` 单独说明：它只是转发器（链路 `Webhook → 解析路由 → 路由有效?`），
  没有协议校验链、也不在站点已注册的工作流清单里；真正执行业务的是目标工作流自己那次执行，
  给网关绑 `executionId` 会让 `runs.execution_id` 指向调度器执行而不是真实业务执行。
  网关外部路由仍接收短 key（例如 `customer-insights`），转发前会把
  `payload.workflowId` 归一成站点 id（例如 `wf_n8n_customer_insights`），确保目标
  工作流能建立精确绑定；除该字段外请求保持原样。
  `generated/manifest.json` 的 `workflows[].binding` 是同一份信息的汇总。

### HTTP 状态码与协议的配合

n8n 是统一的出口，但**边界错误发生在 n8n 之外**（例如 Webhook 节点的 Header Auth 在进入工作流之前就返回 403，全局 Error Workflow 也无法改写响应）。因此约定：

1. **工作流内部可预期的失败** → 用 HTTP 200 + `success:false` 信封返回（网站按 `error.code` 分支）。
2. **n8n 边界失败**（401/403 鉴权、无 Webhook 注册、n8n 宕机、超时）→ 由 **Urtoris 侧的 n8n 客户端归一化**成同样的信封，`engine` 仍为 `n8n`，`error.code` 由 HTTP 状态码映射。

结论：**网站侧永远只处理一种形状**，`success` / `error.code` 是唯一分支依据。

---

## 4. 全链路 requestId

```
浏览器
  │  POST /api/agent/chat            { workflowId, message, sessionId }
  ▼
Urtoris (Worker)  ── 生成 requestId ── 写 runs.request_id
  │  POST /webhook/urtoris/<wf>      统一信封 + Bearer
  ▼
n8n 主工作流 ── common-auth 校验 ── common-log 上报 ── 业务节点
  │  requestId 一路透传（含 Execute Sub-workflow 与 HTTP Tool）
  ▼
子工作流 common-llm / common-log / 全局 Error Workflow
  │
  ▼
Urtoris /api/n8n/events   ← 按 requestId 反查
```

排错动作固定为：**拿到 requestId → `SELECT * FROM runs WHERE request_id = ?` → 拿到 n8n execution id → 在 n8n 里打开这次 execution**。

---

## 5. 幂等 / 重试

- 重试**必须复用同一个 `requestId`**，只递增 `meta.attempt`。
- 只有 `retryable=true` 的错误码 / 网络错误 / 429 / 502 / 503 / 504 才重试。
- 默认最多 2 次投递（1 次重试），退避 400 ms。
- 副作用型工作流（建单、扣款）必须用 `meta.idempotencyKey` 在自己的存储里去重。

---

## 6. 兼容性

- 响应体不是 `urtoris.v1` 信封时（历史工作流返回裸 JSON / 数组），客户端把原始载荷包进 `data.legacy`，并尽力抽取 `reply|text|output|result|message|answer|summary` 作为 `data.message`。
- 请求侧额外字段一律忽略，不做校验报错。
