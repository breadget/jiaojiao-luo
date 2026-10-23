# Workflow Studio：Graph 发布闭环（P0 实现说明）

更新时间：2026-09-13
适用范围：`lib/workflow-graph/*`、`lib/server/workflow-version-store.ts`、`lib/server/graph-runtime-events.ts`、Graph/事件/telemetry API、`drizzle/0007`–`0009`

## 本轮增量：Adapter 1.2.0 真实事件来源

采用 [ADR 001](ADR-001-GRAPH-RUNTIME-EVENTS.md) 的克隆 execution-data forwarder，
入口确定性生成 execution.bound HTTP 节点和严格守卫，200 + ok/bound 布尔 true 才进入危险节点。
Webhook body 展平、请求/session 校验、确定性 webhookId、原生 Qwen/Memory/Condition
及两分支 envelope 已在真实 n8n 2.38.6 验证；模型服务为本地替身。

节点 started/finished/error 来自 n8n 持久化 runData，送达发生在执行定稿之后。
Condition skipped 来自真实空输出口，未映射节点进入 unmappedNodes；无执行数据保持 pending。
`execution.bound` 固定 graphVersion，`sourceSeq` + 事务收据保证幂等/顺序；telemetry 的
`afterSeq` 是独立的 D1 游标，按当前 run.executionId 隔离重试执行，返回 boundVersion 和 eventsComplete。
新 `0009` 必须先应用；`URTORIS_GRAPH_RUNTIME_CANARY` 默认关闭（503），只在被忽略的本机
配置中设为 1。既有 Graph/WorkflowStep 原子双写范围不变。

显式无 Key 用 `llmModel.config.credentialRef=none` 和 `aiAgent.config.fallbackPolicy=rules`，
返回 rules/degraded=true；已声明凭据的鉴权/网络/格式错误一律失败，不触发规则成功。
原生 Simple Memory 仅保证单进程会话复用，本次未把它宣传成持久或跨 worker 存储。

复现、11 个 workflow 顺序、凭据挂载、观察与回滚命令见 [Canary Runbook](CANARY_RUNBOOK.md)。
测试/产物 hash/实际执行 ID/残余边界见 [本轮证据](evidence/graph-runtime-canary.json)。
**Deploy 继续 Adapter locked，生产 n8n 与数据库均未访问。** 下文历史发布接口和原子性约束继续有效。

---

## 1. 现在的模型：草稿 revision ≠ 发布 version

| 概念     | 存放位置                            | 计数器                    | 可变性       |
| -------- | ----------------------------------- | ------------------------- | ------------ |
| 草稿     | `workflow_graph_drafts`             | `revision`（每次保存 +1） | 可反复覆盖   |
| 发布快照 | `workflow_versions`                 | `version`（每次发布 +1）  | **只增不改** |
| 生效指针 | `workflows.active_graph_version_id` | —                         | 回滚就是改它 |

关键性质：

1. **草稿可以一直改，已发布版本不受影响。** 两套编号不共用，改草稿不会动发布版本。
2. **已发布版本不可被覆盖。** 没有 UPDATE 业务字段的代码路径；`(workflow_id, version)`
   上有唯一索引，重复发布只会产生新版本。
3. **一键回滚不删数据。** 回滚只是移动指针，所以可以来回切。
4. **发布为全有或全无。** 编译失败时库里一个字都不写；写库用 D1 `batch`（隐式事务），
   失败后还有一次兜底清理（绑定表 `ON DELETE CASCADE` 会跟着清），不会留下
   "有版本行、没有绑定"的半成品。

### 内容哈希（`graph_hash` / `compiled_hash`）

哈希用**规范 JSON**（键排序）并**归一化掉易变字段**（`revision`、`metadata.updatedAt`），
所以：

- 同一份画布保存两次 → 同一个 `graph_hash`；
- 编译预览得到的 `compiled_hash` **等于**真正发布后写进库的值（"预览即承诺"）。

预览用"即将分配的下一个版本号"，所以预览与实际发布之间没有第二个变数。

---

## 2. API 一览（全部需要管理员授权）

公网请求必须带管理员令牌；本机/内网入口可按
[`OPERATIONS.md`](OPERATIONS.md) 的严格地址与代理链规则获得本地管理会话。

| 方法与路径                                                   | 作用                               | 关键状态码              |
| ------------------------------------------------------------ | ---------------------------------- | ----------------------- |
| `GET /api/workflows/:id/graph`                               | 读草稿（无草稿则返回 legacy 投影） | 401/404                 |
| `PUT /api/workflows/:id/graph`                               | 保存草稿（乐观锁）                 | 400/401/404/**409**/413 |
| `POST /api/workflows/:id/graph/preview`                      | **只读**编译预览，不写库、不导入   | 400/401/404             |
| `POST /api/workflows/:id/graph/publish`                      | 编译 + 固化不可变版本 + 移动指针   | 401/404/409/**422**     |
| `GET /api/workflows/:id/graph/versions`                      | 发布版本列表（含生效标记）         | 401/404                 |
| `POST /api/workflows/:id/graph/versions/:versionId/rollback` | 一键回滚                           | 401/404                 |

状态码语义：

- **409**：草稿 revision 或内容哈希与客户端不一致（本地有未保存修改），响应带
  `currentRevision`，前端重新载入即可继续。
- **422**：编译被拒（不支持的节点类型、缺必填配置、结构错误）。响应带逐条 `issues`。
  此时库里没有任何写入。

### 发布读取的是"库里的草稿"

`POST /publish` 不接受请求体里的图，只接受 `expectedRevision`（可选 `expectedGraphHash`），
然后从 `workflow_graph_drafts` 读出草稿去编译。这样客户端无法绕过草稿校验直接发布任意内容。

---

## 3. Adapter v1.1 支持范围

支持（与 `lib/workflow-graph/adapter/n8n-v1.ts` 一一对应）：

| Graph 节点   | n8n 节点                                      | typeVersion                             |
| ------------ | --------------------------------------------- | --------------------------------------- |
| Trigger      | `n8n-nodes-base.webhook`                      | 2                                       |
| Condition    | `n8n-nodes-base.if`                           | 2.2（`conditions.options.version=2`）   |
| AI Agent     | `@n8n/n8n-nodes-langchain.agent`              | 3.1                                     |
| Qwen Model   | `@n8n/n8n-nodes-langchain.lmChatOpenAi`       | 1.3（显式 `responsesApiEnabled:false`） |
| Memory       | `@n8n/n8n-nodes-langchain.memoryBufferWindow` | 1.4（`customKey`）                      |
| HTTP Tool    | `@n8n/n8n-nodes-langchain.toolHttpRequest`    | 1.1                                     |
| HTTP Request | `n8n-nodes-base.httpRequest`                  | 4.2                                     |
| Robot Action | `n8n-nodes-base.httpRequest`                  | 4.2                                     |
| Output       | `n8n-nodes-base.respondToWebhook`             | 1.5                                     |

Adapter v1.1 还会确定性生成两类边界 Code 节点（`n8n-nodes-base.code`
2）：

- 每个 Trigger 后面加 `role=input`，把 n8n Webhook 的 `body` 展平为
  `$json.requestId/sessionId/message/question/channel/urgency`，并记住执行 id 与开始时间。
- 每个 Output 前面加 `role=envelope`，把成功结果封装成
  `urtoris.v1`，明确写入 `engine=n8n`、`mode`、`degraded=false`、request/session/execution id
  和命中的输出节点。
- `fallbackPolicy=error` 会编译为 Agent 节点的 `onError=stopWorkflow`；
  `rules` 在没有真实备援链路时只给 warning，不伪装成降级成功。

**不支持的类型一律报错并列出节点名**（`database` / `transform` / `subworkflow` /
`legacyStep` / `externalN8nWorkflow`），绝不静默丢弃。

### 三条硬约束

1. **确定性**：节点 id 由 `sha256(workflowId|version|internalNodeId|role)` 生成
   UUID 形状字符串；产物里没有时间戳/随机值；连接目标按名字排序。同一输入重复编译逐字节一致。
2. **去凭据**：config 走**白名单**进入 n8n parameters，密钥字段结构上进不来；
   产物写完后还会跑一次自检，命中疑似凭据就拒绝输出。需要凭据的节点只把引用名
   放进 `requiredCredentialRefs`（`headerAuth` / `openAiApi`），由运维在克隆环境手工挂载。
3. **不半成品**：任何 error 都会让编译返回 `workflow: null`、`compiledJson: null`。

### AI 子节点连接方向（已用真实 n8n 包核实）

**子节点持有连接、指向父 Agent**：

```json
{
  "U::node_model::model": {
    "ai_languageModel": [
      [
        {
          "node": "U::node_agent::primary",
          "type": "ai_languageModel",
          "index": 0
        }
      ]
    ]
  },
  "U::node_memory::memory": {
    "ai_memory": [
      [{ "node": "U::node_agent::primary", "type": "ai_memory", "index": 0 }]
    ]
  },
  "U::node_tool::tool": {
    "ai_tool": [
      [{ "node": "U::node_agent::primary", "type": "ai_tool", "index": 0 }]
    ]
  }
}
```

另外：n8n 的 AI 子节点**不共享主前驱的 item 上下文**（`Agent.node.js` 的 `builderHint`
明确写了这一点），所以 Graph 里只保存 `sessionId` 这样的安全字段路径，
Adapter 再按当前发布版本重建为
`={{ $('U::<triggerNodeId>::input').first().json.sessionId }}`。历史节点引用会被解析为字段路径
后重绑定，无法安全解析则 fail closed。这一条仍**必须在克隆环境实测确认**。

---

## 4. 自动化测试

```bash
npm test
```

零新增运行依赖：Node 24 内置 `node:test` + 已作为传递依赖存在的 `tsx`。
`tests/helpers/loader-hooks.mjs` 把 workerd 专属的 `cloudflare:workers` 重定向到 stub，
`tests/helpers/d1.ts` 用 `node:sqlite` 跑**真实 SQL**（真的唯一约束、真的外键、真的 batch 事务），
`@/db` 用 `mock.module` 注入内存 D1。

夹具（golden）：`tests/fixtures/canary-graph.json` → `canary-compiled.n8n.json`。
产物结构一旦变动，golden 测试就会红，逼着改动者说明是"有意升级"还是"改坏了"。

覆盖：validator（环路 / 端口容量 / Condition 分支 / 重复连接 / 自环）、legacy projector、
Graph API（鉴权 / 大小限制 / 凭据拒绝 / revision 409）、发布闭环（不可变 / 回滚 / 原子性）、
Adapter（确定性 / 去凭据 / 不支持节点拒绝）、100 节点性能基线。

---

## 5. 克隆环境 canary：**导入仍然锁定**

Studio 的 Deploy 按钮保持 `Adapter locked`，`POST /publish` 也**不会**把产物导入 n8n。
要让新 Graph 变成可执行的事实源，需要人工在**克隆环境**完成下列步骤：

1. **备份**：ECS 源码、D1 持久化目录、`.dev.vars`、nginx 与 systemd 配置、n8n 数据库。
2. **应用迁移**：在克隆环境的 D1 依次应用 `0007_workflow_graph.sql`、`0008_workflow_graph_publish.sql`。
   （两者都是 add-only；0008 只加列与索引，不重写任何已有行。）
3. **配置独立管理员令牌**，确认 `URTORIS_ADMIN_TOKEN` 与 `URTORIS_API_TOKEN` 不同值。
4. **取产物**：在 Studio 用「编译预览」后点「下载 n8n JSON」，或直接读
   `workflow_versions.compiled_json`。产物**不含凭据**。
5. **手工挂载凭据**（按 `requiredCredentialRefs`）：Header Auth（webhook）与
   OpenAI 兼容凭证（Chat Model）。产物里故意没有 `credentials` 字段。
6. **在克隆 n8n 导入并发布**，跑 W1/W4 与 Graph canary，重点确认：
   - 输入归一节点确实展平 Webhook body，Memory 的 `sessionKey` 在子节点
     上下文里取到正确的 `sessionId`，且不同 session 互不可见；
   - `lmChatOpenAi` 对 DashScope 这类 OpenAI 兼容端点可用（已显式关闭 Responses API）；
   - Condition 的 true/false 真的走到不同分支，两个出口都返回合法
     `urtoris.v1` 信封（`options.version` 与 typeVersion 成对）；
   - 模型错误时 Agent 停止工作流，不返回 `mode=rules` 的伪成功。
7. **canary 通过后**才讨论解锁 Deploy；解锁之前不要碰生产 n8n。

保持 `EXECUTIONS_DATA_SAVE_ON_SUCCESS=all` 直到克隆环境确认终态问题已修复。

---

## 6. 已知的、故意留到后面的东西

- `workflow_versions` 与旧 `WorkflowStep[]` 的**原子双写**没有做：本次只实现 Graph 侧
  的不可变快照。旧 `workflows.published_steps_json` 仍由原来的 `/api/workflows` 路径管理，
  两条发布链路目前互不影响，也互不同步。
- 克隆环境的 `external_workflow_id` / `webhook_path` 回填：产物导入 n8n 后拿到真实的
  workflow id，需要再写回 `workflow_versions.external_workflow_id`。当前留空。
- 节点级真实事件流已按 P0 完成第一版：`workflow_node_bindings` 反查内部 nodeId，
  Studio 用 `?afterSeq=` 游标轮询 `/api/runs/:requestId/telemetry`，没有事件就不点亮。
  仍未做的是 SSE 推送、`run_node_states` 物化表，以及节点级 Input / Output / Log /
  Error 快照（当前只有状态、耗时和冲突计数）。

---

## 7. 提前绑定契约：`execution.bound`

工作流必须在**危险节点之前**（LLM / HTTP / Tool / Robot Action）把
`requestId ↔ executionId` 报给站点，否则运行结束后只能靠 ±2 分钟时间窗猜，
节点级遥测就没有可靠的时间基准。

### 顺序：先校验 requestId，再绑定

```text
Webhook → 校验请求 → 请求合法?
   ├─ true  → 绑定执行 (execution.bound) → 归一绑定结果 → 绑定成功?
   │             ├─ true  → 既有首节点 → … → 危险节点
   │             └─ false → Respond to Webhook   （BINDING_FAILED）
   └─ false → 组装错误 → … → Respond to Webhook  （VALIDATION_ERROR）
```

**没有 requestId 就绝不调用站点。** 绑定阶段位于既有协议校验**之后**，
所以缺 `requestId` / `workflowId` 的请求会走原有的 `VALIDATION_ERROR` 分支，
既不会污染 `n8n_execution_map`，也不会把错误码从 `VALIDATION_ERROR`
误报成 `BINDING_FAILED`。

### n8n 侧必须发送

```http
POST /api/n8n/events
Authorization: Bearer <URTORIS_INTERNAL_TOKEN>
Content-Type: application/json

{
  "requestId": "4a1c2f7e-...",
  "executionId": "772",
  "workflowId": "wf_n8n_llm_smoke",
  "triggerNodeId": "webhook-26",
  "eventType": "execution.bound"
}
```

- `workflowId` **必须是站点侧的工作流 id**（协议 body 里 `workflowId` 的值，
  形如 `wf_n8n_llm_smoke`），**不是** n8n 自己的工作流 id（`urtoris-wf-llm-smoke`）。
  生成器从 `$json.payload.workflowId` 取；写死 n8n 的 id 会被 404 拒掉。
- `triggerNodeId` 可以是 n8n 的节点 id 或名字；也接受 `node` 作为别名。

### 站点的响应契约（fail closed）

| 情况                                                                  | 状态码 | code                       | n8n 侧应当                      |
| --------------------------------------------------------------------- | ------ | -------------------------- | ------------------------------- |
| 字段齐全且首见                                                        | 200    | —                          | 继续进危险节点                  |
| 字段齐全且重复上报                                                    | 200    | —                          | 继续（幂等，不新增映射）        |
| 缺 `requestId` / `executionId` / `workflowId`，或 requestId=`unknown` | 400    | `BINDING_INVALID`          | **停止**，返回 `BINDING_FAILED` |
| 内部令牌无效                                                          | 401    | —                          | **停止**                        |
| `workflowId` 不是站点已知工作流                                       | 404    | `BINDING_UNKNOWN_WORKFLOW` | **停止**                        |
| `executionId` 已绑到别的 `requestId`                                  | 409    | `BINDING_CONFLICT`         | **停止**                        |
| 未配置 `URTORIS_INTERNAL_TOKEN`                                       | 503    | —                          | **停止**                        |

**只有 200 + `{ ok: true, bound: true }` 才允许往下走。**

### 三条不可放宽的规则

1. **绑定不可覆盖。** 一个 `executionId` 只能对应一个 `requestId`。重复上报同一对
   是幂等的；想用同一个 `executionId` 绑到别的 `requestId` 一律 409，
   旧值原封不动。绑定入口允许同一 `requestId` 记录多个真实 `executionId`，用于
   n8n 内部受控重试或传输结果不确定的恢复；对外 API 若已有 run，则只会幂等重放，
   不会重复触发工作流。
2. **节点级映射只能来自 `workflow_node_bindings`。** `triggerNodeId` 查到就点亮，
   查不到就是 `internalNodeId: null` 并进 `unmappedNodes`。**任何情况下都不猜 nodeId。**
   注意：非 Graph 发布的工作流（含现有 11 个生成工作流）本来就没有绑定行，
   所以"节点未映射"是正常状态，不构成绑定失败。
3. **旧工作流标 legacy。** 没有绑定阶段的运行仍允许 ±2 分钟时间窗 fallback，
   但遥测接口会把它标成 `binding: 'legacy'`，不和 `'prebound'` 混为一谈。
