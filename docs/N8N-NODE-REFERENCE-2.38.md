# n8n 2.38.x 节点定义速查（可手工生成可导入的 workflow JSON）

> **验证方法**：本文所有 `type` / `typeVersion` / `parameters` 形状，均从 **n8n 2.38.6（当前 npm `latest`）实际依赖的包**里反编译核对，
> 不是从文档推测的。核对方式：下载官方 npm 包 → 实例化节点类 → 读取 `description` / `properties` 真实对象；IF 的 filter 形状还用
> `n8n-workflow` 的 `executeFilter()` **实际执行验证过**。
>
> **核对基线**（`n8n@2.38.6` 的 dependencies，见 `npm view n8n@2.38.6 dependencies`）：
>
> | 包 | 版本 | 说明 |
> | --- | --- | --- |
> | `n8n-nodes-base` | **2.38.2** | 核心节点（webhook / if / httpRequest …） |
> | `@n8n/n8n-nodes-langchain` | **2.38.2** | AI 节点（agent / lmChatOpenAi / memory / tool） |
> | `n8n-workflow` | **2.38.1** | 类型系统与 filter 引擎 |
>
> `npm view n8n dist-tags` → `latest: 2.38.6`、`beta/next: 2.39.2`。若要严格对齐 "2.38.x"，请锁 `n8n@2.38.6`。
> ⚠️ n8n 每天多次发布，**2.39.x 起 typeVersion 可能上调**，重新核对成本很低（见文末「如何自己复核」）。

---

## 0. 最重要的一条：你的仓库现在钉的是旧版本

`tools/build-workflows.mjs` 目前写的是 `typeVersion: 2`（webhook / if）、`typeVersion: 3`（agent）、`1.2`（lmChatOpenAi）、
`4.2`（httpRequest）、`1`（respondToWebhook）等**旧版**。

- **结论：这些旧 typeVersion 在 2.38.6 上依然完全可用**（`VersionedNodeType` 保留了全部历史版本，`getNodeType(version)` 按你写的数字取实现）。
  n8n 的版本策略是「新版本只是新默认值，旧版本永久保留」。所以**现有 workflows 不需要为了升级 n8n 而改 typeVersion**。
- **但** 本文给出的是 **2.38.2 包里的最新版本号 / 当前默认版本**。两种情况请区分：
  1. 你要和仓库已有 workflows 保持一致 → 继续用旧号（本文每个节点都标注了旧号是否仍支持）。
  2. 你要新写节点、走「当前默认」 → 用本文的号。
- **唯一真正的坑**：IF 节点 `conditions.options.version` 与 `typeVersion` **强耦合**。
  `typeOptions.filter.version` 的定义是 `={{ $nodeVersion >= 2.3 ? 3 : $nodeVersion >= 2.2 ? 2 : 1 }}`。
  即：`typeVersion ≥ 2.3` → 必须 `options.version: 3`；`2.2` → `2`；`2.0/2.1` → `1`。写错不会报错，**只会静默算错**。
  （仓库现在是 `typeVersion: 2.2` + `options.version: 2` —— 正确，不要动。）

---

## 1. `n8n-nodes-base.webhook`

- `type`: `n8n-nodes-base.webhook`
- `typeVersion`: **2.1**（当前默认）
  - `description.version = [1, 1.1, 2, 2.1]`，`defaultVersion = 2.1`
  - ⚠️ 仓库现在用 `2`，仍受支持。`2` 与 `2.1` 的参数差异：`responseMode` 在 `<2.1` 上不含 `streaming`；**`responseNode` 两者都有**。
- `parameters` 最小可用（POST + 静态 path + `responseMode: responseNode`）：

```json
{
  "parameters": {
    "httpMethod": "POST",
    "path": "urtoris/customer-service",
    "responseMode": "responseNode",
    "options": {}
  },
  "type": "n8n-nodes-base.webhook",
  "typeVersion": 2.1
}
```

要点：
- `path` 填**纯路径片段**，不要带前导 `/`、不要带 `/webhook` 前缀；实际 URL 是 `{baseUrl}/webhook/{path}`。
  支持 `:` 动态段（如 `urtoris/:tenant`）。默认 `""`。
- `httpMethod` 默认 `"GET"`；可选 `DELETE, GET, HEAD, PATCH, POST, PUT`。
  （当 `multipleMethods: true` 时该字段变 `multiOptions`，数组形如 `["GET","POST"]`。）
- `responseMode` 可选 `onReceived`（默认）| `lastNode` | `responseNode` | `streaming`(≥2.1)。
  **只有 `responseNode` 才允许下游用 Respond to Webhook 节点控制响应**。
- `responseData`（默认 `firstEntryJson`，仅 `responseMode: lastNode` 时可填）：`allEntries|firstEntryJson|firstEntryBinary|noData`。
- `responseCode` 默认 `200`；但用 `responseNode` 时实际响应码由 Respond 节点决定。
- `options` 可省，留 `{}` 最安全。可选项：`binaryData, binaryPropertyName, ignoreBots, ipWhitelist, noResponseBody, onlyRunIf, responsePropertyName, rawBody, responseCode, responseContentType, responseData, responseHeaders`。
- `authentication` 默认 `"none"`；用 header auth 时填 `"headerAuth"` 并在节点 `credentials` 里挂 `httpHeaderAuth`。
- **`webhookId` 是可选字段**（`INode.webhookId?`），n8n 在激活/导入时会自动补齐并写库，手写可省略。
- 输出端口是动态的：`outputs` 由 `httpMethod` 推导 —— 单方法 1 个 `main` 输出，多方法时每个方法一个 `main` 输出（影响 `connections` 的输出索引）。

来源：
- `n8n-nodes-base@2.38.2` → `dist/nodes/Webhook/Webhook.node.js`、`dist/nodes/Webhook/description.js`
- https://www.npmjs.com/package/n8n-nodes-base/v/2.38.2
- 文档：https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/
- 源码（同版本 tag）：https://github.com/n8n-io/n8n/tree/n8n%402.38.6/packages/nodes-base/nodes/Webhook

---

## 2. `n8n-nodes-base.respondToWebhook`

- `type`: `n8n-nodes-base.respondToWebhook`
- `typeVersion`: **1.5**（当前默认）
  - `description.version = [1, 1.1, 1.2, 1.3, 1.4, 1.5]`，`defaultVersion = 1.5`
  - ⚠️ 仓库现在用 `1`，仍受支持；`respondWith` 的选项集在 `1` 和 `1.5` 上一致。
- `parameters` 最小可用（返回手写 JSON body）：

```json
{
  "parameters": {
    "respondWith": "json",
    "responseBody": "={{ { \"protocol\": \"urtoris.v1\", \"success\": true } }}",
    "options": { "responseCode": 200 }
  },
  "type": "n8n-nodes-base.respondToWebhook",
  "typeVersion": 1.5
}
```

要点：
- `respondWith` 默认 `"firstIncomingItem"`；可选 `allIncomingItems | binary | firstIncomingItem | json | jwt | noData | redirect | text`。
  - 想「直接把上游 JSON 透传」→ 用默认 `firstIncomingItem`，**不需要** `responseBody`。
  - 想「自定义 JSON」→ `"json"` + `responseBody`。
- `responseBody` 类型随 `respondWith` 变：`respondWith:"json"` 时 `type: "json"`（**注意：是 json 类型，填字符串即可，n8n 会当表达式/JSON 处理**），
  `respondWith:"text"` 时 `type: "string"`（同名字段）。
- `options`（collection，默认 `{}`）：`responseCode`(number, 默认 200)、`responseHeaders`(fixedCollection `{entries:[{name,value}]}`)、`responseKey`(string)、`enableStreaming`(boolean, 默认 true)。
- 前置条件：上游 Webhook 必须 `responseMode: "responseNode"`，否则该节点在运行时直接报错。

来源：
- `n8n-nodes-base@2.38.2` → `dist/nodes/RespondToWebhook/RespondToWebhook.node.js`
- https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.respondtowebhook/
- 源码：https://github.com/n8n-io/n8n/tree/n8n%402.38.6/packages/nodes-base/nodes/RespondToWebhook

---

## 3. `n8n-nodes-base.if`（重点：v2 filter 精确形状）

- `type`: `n8n-nodes-base.if`
- `typeVersion`: **2.3**（当前默认）
  - `If.node.js` → `defaultVersion: 2.3`；`IfV2.node.js` → `version: [2, 2.1, 2.2, 2.3]`
  - ⚠️ 仓库现在用 `2.2`，仍受支持。
- 输出：两个 `main` 输出，`outputNames: ['true','false']` → `connections` 里索引 `0` = true，`1` = false。
- `parameters` 最小可用（单条件字符串相等）：

```json
{
  "parameters": {
    "conditions": {
      "options": {
        "caseSensitive": true,
        "leftValue": "",
        "typeValidation": "strict",
        "version": 3
      },
      "conditions": [
        {
          "id": "cond-1",
          "leftValue": "={{ $json.protocol }}",
          "rightValue": "urtoris.v1",
          "operator": {
            "type": "string",
            "operation": "equals"
          }
        }
      ],
      "combinator": "and"
    },
    "options": {}
  },
  "type": "n8n-nodes-base.if",
  "typeVersion": 2.3
}
```

### filter 对象的权威结构（来自 `n8n-workflow@2.38.1` 类型定义）

```ts
type FilterValue = {
  options: FilterOptionsValue;          // 必填对象
  conditions: FilterConditionValue[];   // 必填数组
  combinator: 'and' | 'or';             // 必填
};
type FilterOptionsValue = {
  caseSensitive: boolean;
  leftValue: string;                    // 通常 ""
  typeValidation: 'strict' | 'loose';
  version: 1 | 2 | 3;                   // 见下方与 typeVersion 的耦合
};
type FilterConditionValue = {
  id: string;                           // 后端不校验，前端树状视图用；建议写
  leftValue: NodeParameterValue | NodeParameterValue[];
  operator: FilterOperatorValue;
  rightValue: NodeParameterValue | NodeParameterValue[];
};
interface FilterOperatorValue {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'dateTime' | 'any';
  operation: string;                    // 如 'equals', 'notEquals', 'contains', 'gt', 'lt', 'regex', 'exists', 'true', 'false' ...
  rightType?: FilterOperatorType;        // 少见
  singleValue?: boolean;                 // 单值操作为 true；缺省也可
}
```

**逐字段实测结论**（用 `n8n-workflow@2.38.1` 的 `executeFilter()` 真跑过）：

| 写法 | 结果 |
| --- | --- |
| 完整 4 件套（options + conditions + combinator + operator） | ✅ 正常求值 |
| **省略 `options`** | ❌ 运行时崩溃：`Cannot read properties of undefined (reading 'caseSensitive')` |
| `options` 里省略 `version` | ✅ 可跑（内部默认 1），但**类型转换行为会不同**，建议显式写 |
| **省略 `combinator`** | ⚠️ 不报错，但恒返回 `false`（**静默算错**，最危险） |
| 条件里省略 `id` | ✅ 可跑（`id` 不是后端必需） |
| `operator.singleValue` | 可选；`equals` 这类单值操作不写也正确 |
| 条件里省略 `leftValue` | ⚠️ 不报错，恒 `false` |
| `operation` 写错（如 `bogus`） | ⚠️ 不报错，恒 `false` |

**`options.version` 与 `typeVersion` 的耦合（必须记住）**：
`typeVersion 2.3 → version 3`；`2.2 → 2`；`2.0 / 2.1 → 1`。
（来源：`IfV2.node.js` 的 `typeOptions.filter.version = '={{ $nodeVersion >= 2.3 ? 3 : $nodeVersion >= 2.2 ? 2 : 1 }}'`）

其它：
- `parameters.options`（collection，默认 `{}`）：v2.0 只有 `ignoreCase`（默认 `true`）；v2.1+ 起 `looseTypeValidation`(boolean, 默认 false) 从 `options` 移到**顶层参数**；`options.ignoreCase` 依然存在。
- `caseSensitive` 建议显式写 `true`，因为 `typeOptions.filter.caseSensitive = '={{!$parameter.options.ignoreCase}}'`——默认 `ignoreCase: true` 会让大小写不敏感，容易踩坑。

来源：
- `n8n-nodes-base@2.38.2` → `dist/nodes/If/If.node.js`、`dist/nodes/If/V2/IfV2.node.js`
- `n8n-workflow@2.38.1` → `dist/cjs/interfaces.d.ts`（`FilterValue` / `FilterConditionValue` / `FilterOperatorValue` 定义）、`dist/cjs/node-parameters/filter-parameter.js`（`executeFilter`）
- https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.if/
- 源码：https://github.com/n8n-io/n8n/tree/n8n%402.38.6/packages/nodes-base/nodes/If

---

## 4. `n8n-nodes-base.httpRequest`

- `type`: `n8n-nodes-base.httpRequest`
- `typeVersion`: **4.5**（当前默认）
  - `HttpRequest.node.js` → `defaultVersion: 4.5`；`HttpRequestV3.node.js` → `version: [3, 4, 4.1, 4.2, 4.3, 4.4, 4.5]`
  - ⚠️ 仓库现在用 `4.2`，仍受支持。`4.3/4.4/4.5` 主要增补参数（如 `sslCertificate`、`provideSslCertificates`），基础 POST JSON 写法完全一致。
- `parameters` 最小可用（POST JSON body）：

```json
{
  "parameters": {
    "method": "POST",
    "url": "https://api.example.com/v1/orders",
    "sendBody": true,
    "contentType": "json",
    "specifyBody": "json",
    "jsonBody": "={{ { \"requestId\": $json.requestId, \"message\": $json.message } }}",
    "options": {}
  },
  "type": "n8n-nodes-base.httpRequest",
  "typeVersion": 4.5
}
```

要点（全部为 v4.5 实测默认值/形状）：
- `method` 默认 `"GET"`；`url` 默认 `""`（string，必填语义）。
- `authentication` 默认 `"none"`；可选 `none | predefinedCredentialType | genericCredentialType`。
  用预置凭证 → 填 `authentication: "predefinedCredentialType"` + `nodeCredentialType: "<credType>"`。
  用通用凭证 → `authentication: "genericCredentialType"` + `genericAuthType: "customAuth"`。
- 请求体三件套：`sendBody: true` → `contentType`（默认 `"json"`；可选 `json | form-urlencoded | multipart-form-data | binaryData | raw`）
  → 当 `contentType: "json"` 时 `specifyBody`（`"keypair"` 默认 | `"json"`）。
  - `specifyBody: "json"` → 用 **`jsonBody`**（`type: "json"`，默认 `""`）。
  - `specifyBody: "keypair"` → 用 **`bodyParameters`**：`{"parameters":[{"name":"...","value":"..."}]}`。
- Query：`sendQuery: true` → `specifyQuery`（`keypair` 默认 | `json`）→ `queryParameters.parameters[]` 或 `jsonQuery`(json)。
- Headers：`sendHeaders: true` → `specifyHeaders`（`keypair` | `json`）→ `headerParameters.parameters[]` 或 `jsonHeaders`(json)。
- `options`（collection，默认 `{}`）常用：`response.response`（`{response:{fullResponse,neverError,responseFormat,outputPropertyName}}`）、`timeout`、`redirect`、`batching`、`proxy`、`allowUnauthorizedCerts`、`pagination`。
- 该节点凭证槽只有 `httpSslAuth`（`provideSslCertificates: true` 时启用），**没有默认 auth 凭证**。

来源：
- `n8n-nodes-base@2.38.2` → `dist/nodes/HttpRequest/HttpRequest.node.js`、`dist/nodes/HttpRequest/V3/Description.js`
- https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/
- 源码：https://github.com/n8n-io/n8n/tree/n8n%402.38.6/packages/nodes-base/nodes/HttpRequest

---

## 5. `n8n-nodes-base.noOp`

- `type`: `n8n-nodes-base.noOp`
- `typeVersion`: **1**（只有 1，`version: 1`，非 versioned 节点）
- `parameters`: **`{}`**（该节点无任何参数）

```json
{
  "parameters": {},
  "type": "n8n-nodes-base.noOp",
  "typeVersion": 1
}
```

来源：
- `n8n-nodes-base@2.38.2` → `dist/nodes/NoOp/NoOp.node.js`
- https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.noop/

---

## 6. `n8n-nodes-base.executeWorkflow`

- `type`: `n8n-nodes-base.executeWorkflow`
- `typeVersion`: **1.3**（当前默认）
  - `ExecuteWorkflow.node.js` → `version: [1, 1.1, 1.2, 1.3]`，**无显式 `defaultVersion`** → 按 `VersionedNodeType` 规则取最大版本 = `1.3`（`n8n-workflow/dist/cjs/versioned-node-type.js`: `this.currentVersion = description.defaultVersion ?? this.getLatestVersion()`）
- `parameters` 最小可用（按 id 调用子工作流）：

```json
{
  "parameters": {
    "source": "database",
    "workflowId": {
      "__rl": true,
      "value": "<子工作流ID>",
      "mode": "id"
    },
    "mode": "once",
    "options": {}
  },
  "type": "n8n-nodes-base.executeWorkflow",
  "typeVersion": 1.3
}
```

要点：
- `operation` 是 `hidden`，默认 `"call_workflow"`，手写可省略。
- `source`（v1.2+）默认 `"database"`；可选 `database | parameter | localFile | url`
  （v1.1 及以下还有 `localFile/url`，且 v1.2 起给 `source: localFile|url` 加了 deprecation notice）。
- `workflowId` 的类型随版本变：
  - `typeVersion: 1` → `type: "string"`（直接填 id 字符串，`default: ""`）
  - `typeVersion ≥ 1.1` → `type: "workflowSelector"`（一种 resourceLocator 形态，**必填**）
  resourceLocator 通用形状为 `{"__rl": true, "value": "...", "mode": "list"|"id", "cachedResultName": "..."}`；
  按 id 调用用 `"mode": "id"`，从列表选则 `"mode": "list"` + `cachedResultName`。
  > ⚠️ `workflowSelector` 不是标准 `resourceLocator` 类型名而是其前端变体；上面形状与 n8n 内置 resourceLocator 一致，导入 n8n 后可在 UI 中正常回显。**若对 `cachedResultName` 是否为必填有疑虑，直接省略 `cachedResultName` 即可（UI 会自行解析名称）。**
- `mode`（默认 `"once"`）：`once` = 所有 items 跑一次；`each` = 每个 item 跑一次（`each` 会带 deprecation notice）。
- `workflowInputs`：`type: "resourceMapper"`，`typeVersion ≥ 1.2` 有效。**不传输入时可省略整个字段**；若要传，形状见 resourceMapper 类型定义。
- `options`（collection，默认 `{}`）：`waitForSubWorkflow`(boolean, 默认 true) 等。
- 子工作流里接输入要用 `n8n-nodes-base.executeWorkflowTrigger`。

来源：
- `n8n-nodes-base@2.38.2` → `dist/nodes/ExecuteWorkflow/ExecuteWorkflow/ExecuteWorkflow.node.js`
- `n8n-workflow@2.38.1` → `dist/cjs/versioned-node-type.js`
- https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow/
- 源码：https://github.com/n8n-io/n8n/tree/n8n%402.38.6/packages/nodes-base/nodes/ExecuteWorkflow

---

## 7–10. AI 子节点（`@n8n/n8n-nodes-langchain.*`）

### 7. `@n8n/n8n-nodes-langchain.agent` — AI Agent

- `type`: `@n8n/n8n-nodes-langchain.agent`
- `typeVersion`: **3.1**（当前默认）
  - `Agent.node.js` → `defaultVersion: 3.1`；`AgentV3.node.js` → `version: [3, 3.1]`
  - ⚠️ **仓库现在用 `2`（旧版 agent）**，仍受支持，但 v2 的参数结构（`agent`/`promptType`/`text`/`options.systemMessage`）与 v3.x 不同：
    - v1.x 需要 `agent` 参数（`conversationalAgent|toolsAgent|openAiFunctionsAgent|reActAgent|sqlAgent|planAndExecuteAgent`）
    - v2.x / v3.x 不再需要 `agent` 参数（已统一为 tools agent 实现）
- `parameters` 最小可用（system prompt + 用户消息）：

```json
{
  "parameters": {
    "promptType": "define",
    "text": "={{ $json.message }}",
    "options": {
      "systemMessage": "你是一个严谨的中文客服助手。",
      "maxIterations": 10
    }
  },
  "type": "@n8n/n8n-nodes-langchain.agent",
  "typeVersion": 3.1
}
```

要点（v3.1 实测）：
- 输入：`main` + `ai_languageModel`（**必填**，maxConnections=1）+ `ai_memory` + `ai_tool` + `ai_outputParser`（可选）。
  `ai_memory` / `ai_outputParser` 也受 maxConnections=1 限制。
- `promptType` 默认 `"auto"`；v3.1 起可选值 = `auto | define`（**v3.1 移除了 `guardrails`**；`<3.1` 才有 `guardrails`）。
  - `auto`：从直连的 Chat Trigger 取 `chatInput`
  - `define`：用 `text` 字段
- `text`（string，**required: true**）默认值随 `promptType` 变：`auto` → `"={{ $json.chatInput }}"`，`define` → `""`。
- `options`（collection，默认 `{}`）可用键：`systemMessage`(string, 默认 `"You are a helpful assistant"`)、`maxIterations`(number, 默认 10)、
  `returnIntermediateSteps`(bool, 默认 false)、`passthroughBinaryImages`(bool, 默认 true)、`passthroughBinaryPdfs`(bool, 默认 false)、
  `tracingMetadata`(fixedCollection)、`enableStreaming`(bool, 默认 true)、`maxTokensFromMemory`(hidden)。
- `hasOutputParser`（bool, 默认 false）与 `needsFallback`（bool, 默认 false）控制动态输入端口数量。
- 输出：单个 `main`。

来源：
- `@n8n/n8n-nodes-langchain@2.38.2` → `dist/nodes/agents/Agent/Agent.node.js`、`dist/nodes/agents/Agent/V3/AgentV3.node.js`、`dist/utils/descriptions.js`
- https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/

---

### 8. `@n8n/n8n-nodes-langchain.lmChatOpenAi` — OpenAI 兼容 Chat Model

- `type`: `@n8n/n8n-nodes-langchain.lmChatOpenAi`
- `typeVersion`: **1.3**（当前默认，包内最高版即 1.3）
  - `description.version = [1, 1.1, 1.2, 1.3]`（`types/nodes.json` 里 `defaultVersion` 为空 → 取最大 = 1.3）
  - ⚠️ 仓库现在用 `1.2`，仍受支持。**1.2 → 1.3 的差异**：1.3 新增 `responsesApiEnabled`（bool，默认 `true`）与 `builtInTools`。
    如果你走的是 OpenAI-compatible 第三方端点（如 DashScope），**建议显式设 `responsesApiEnabled: false`**，因为 Responses API 未必被兼容端点支持。
- `parameters` 最小可用（自定义 baseURL + 凭证引用）：

```json
{
  "parameters": {
    "model": {
      "__rl": true,
      "mode": "list",
      "value": "qwen-plus",
      "cachedResultName": "qwen-plus"
    },
    "responsesApiEnabled": false,
    "options": {
      "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "temperature": 0.7,
      "maxTokens": -1
    }
  },
  "type": "@n8n/n8n-nodes-langchain.lmChatOpenAi",
  "typeVersion": 1.3,
  "credentials": {
    "openAiApi": { "id": "<凭证ID>", "name": "OpenAI account" }
  }
}
```

要点（v1.3 实测）：
- **凭证名是 `openAiApi`（required: true）**，节点形状 `credentials: { openAiApi: { id, name } }`。
  BYO Key 有两条路：
  1. 在 n8n 里建一个 `openAiApi` 凭证，节点只放引用（如上）——**推荐**，密钥不进 workflow JSON。
  2. `credentials` 里不带密钥；密钥由上游数据流运行时注入（你们的 `context.llm.apiKey` 协议就是这个思路），
     此时需配合 HTTP Request 或自定义逻辑，`lmChatOpenAi` 本身**不支持**从参数里读 apiKey。
- `model`：`type: "resourceLocator"`，**required: true**，默认 `{"mode":"list","value":"gpt-5-mini"}`。
  自定义端点的模型名直接写 `"mode": "list"` + `"value": "<model-id>"` 即可（`list` 模式允许自由填值）。
  1.2 起才有 resourceLocator；`≤1.1` 时是 `type: "options"`，直接写字符串 `"model": "gpt-4o-mini"`。
- `options.baseURL`（string，默认 `"https://api.openai.com/v1"`）：**这就是自定义 baseURL 的入口**。
- `options` 其它常用默认值：`temperature` 0.7、`maxTokens` -1、`frequencyPenalty` 0、`presencePenalty` 0、
  `topP` 1、`timeout` 60000、`maxRetries` 2、`responseFormat` `"text"`、`reasoningEffort` `"medium"`。
- `responsesApiEnabled`（v1.3 新增，默认 `true`）、`builtInTools`（v1.3 新增）。
- 输出端口类型：`ai_languageModel`；无 `main` 输入。**它只作为子节点存在，不作为主流程节点**。

来源：
- `@n8n/n8n-nodes-langchain@2.38.2` → `dist/nodes/llms/LMChatOpenAi/LmChatOpenAi.node.js`、`dist/types/nodes.json`、`dist/node-definitions/nodes/n8n-nodes-langchain/lmChatOpenAi/v13.schema.js`
- https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatopenai/

---

### 9. `@n8n/n8n-nodes-langchain.memoryBufferWindow` — Simple Memory

- `type`: `@n8n/n8n-nodes-langchain.memoryBufferWindow`
- `typeVersion`: **1.4**（当前默认，包内最高版即 1.4）
  - `MemoryBufferWindow.node.js` → `version: [1, 1.1, 1.2, 1.3, 1.4]`，无显式 `defaultVersion` → 取最大 = **1.4**
  - ⚠️ 仓库现在用 `1.3`，仍受支持。
- `parameters` 最小可用（固定 session key + 窗口长度）：

```json
{
  "parameters": {
    "sessionIdType": "customKey",
    "sessionKey": "={{ $json.sessionId }}",
    "contextWindowLength": 10
  },
  "type": "@n8n/n8n-nodes-langchain.memoryBufferWindow",
  "typeVersion": 1.4
}
```

要点（v1.4 实测）：
- `displayName` 是 **"Simple Memory"**（不是 "Window Buffer Memory"，后者是旧叫法/文档名）。
- 无输入、无凭证；输出端口类型 `ai_memory`，`outputNames: ['Memory']`。
- `sessionIdType`（options，**≥1.2 才有此参数**）：默认 `"fromInput"`；可选 `fromInput` | `customKey`。
  - `fromInput`：从直连 Chat Trigger 的 `sessionId` 字段取
  - `customKey`：用 `sessionKey`
- `sessionKey`（string）：值随版本/模式变
  - `typeVersion: 1` → 字段存在，默认 `"chat_history"`（无 `sessionIdType`）
  - `typeVersion: 1.1` → 默认 `"={{ $json.sessionId }}"`
  - `typeVersion: 1.2/1.3`（`sessionIdType: fromInput`）→ 默认 `"={{ $json.sessionId }}"`
  - `typeVersion ≥1.2`（`sessionIdType: customKey`）→ 默认 `""`，必填语义
- `contextWindowLength`（number，默认 **5**）：可省，省略即 5。
- ⚠️ v1.4 新增 scoped-session 行为：会话默认**只对该 memory 节点作用域生效**；要跨多个 memory 节点共享，需 `sessionIdType: customKey` 且各节点用同一个 key。
- 它在本机存内存 → **不兼容 queue mode / multi-main**，生产要多 worker 请换 Redis/Postgres memory。

来源：
- `@n8n/n8n-nodes-langchain@2.38.2` → `dist/nodes/memory/MemoryBufferWindow/MemoryBufferWindow.node.js`、`dist/nodes/memory/descriptions.js`
- https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.memorybufferwindow/

---

### 10. `@n8n/n8n-nodes-langchain.toolHttpRequest` — HTTP Request Tool

- `type`: `@n8n/n8n-nodes-langchain.toolHttpRequest`
- `typeVersion`: **1.1**（当前默认，包内最高版即 1.1）
  - `ToolHttpRequest.node.js` → `version: [1, 1.1]`，无显式 `defaultVersion` → 取最大 = **1.1**
- `parameters` 最小可用（给 agent 用的 POST JSON 工具）：

```json
{
  "parameters": {
    "toolDescription": "查询订单物流状态。输入订单号，返回最新物流节点。",
    "method": "POST",
    "url": "https://api.example.com/v1/logistics",
    "sendBody": true,
    "specifyBody": "json",
    "jsonBody": "={ \"orderId\": \"{orderId}\" }",
    "placeholderDefinitions": {
      "values": [
        {
          "name": "orderId",
          "description": "订单号，如 SO20250101001",
          "type": "string"
        }
      ]
    }
  },
  "type": "@n8n/n8n-nodes-langchain.toolHttpRequest",
  "typeVersion": 1.1
}
```

要点（v1.1 实测）：
- 无输入、无凭证槽（`credentials: []`）；输出端口类型 `ai_tool`，`outputNames: ['Tool']`。
- `toolDescription`（string，默认 `""`）：**给 LLM 看的说明**，写不好 LLM 就不会正确调用，建议必填。
- `method` 默认 `"GET"`；可选 `DELETE | GET | PATCH | POST | PUT`（**比 httpRequest 少了 HEAD**）。
- `url`（string，**required: true**）：支持 `{placeholder}` 占位符由模型填。
- `authentication` 默认 `"none"`；可选 `none | predefinedCredentialType | genericCredentialType`。
- 请求体：`sendBody: true` → `specifyBody`（默认 `"keypair"`；可选 **`keypair | json | model`**）
  - `json` → 用 `jsonBody`（string，**注意是 string 不是 json 类型**）
  - `model` → 整个 body 交给模型生成
  - `keypair` → `parametersBody.values[]`
- Query：`sendQuery` / `specifyQuery` / `parametersQuery.values[]` / `jsonQuery`（string）
- Headers：`sendHeaders` / `specifyHeaders` / `parametersHeaders.values[]` / `jsonHeaders`（string）
- `placeholderDefinitions`（fixedCollection，默认 `[]`）：`{values:[{name, description, type}]}`，用于给占位符补上下文。
- `optimizeResponse`（bool，默认 false）：开启后可用 `responseType` / `dataField` / `fieldsToInclude` / `cssSelector` / `truncateResponse` / `maxLength`(默认 1000) 等裁剪响应，省 token。

来源：
- `@n8n/n8n-nodes-langchain@2.38.2` → `dist/nodes/tools/ToolHttpRequest/ToolHttpRequest.node.js`、`dist/nodes/tools/ToolHttpRequest/descriptions.js`
- https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolhttprequest/

---

## 11. 【关键问题一】AI 子节点的连接类型 key 与方向

**结论：你的理解是对的 —— 是「子节点持有连接、指向父 Agent」。**

- 连接类型 key 是**子节点自己的输入端口字符串**，而连接**存储在子节点（source）的 `connections[子节点名]` 里**，`node` 指向 Agent。
- 为什么方向是「子 → 父」：n8n 的 `connections` 语义是 `connections[源节点名][输出端口类型][输出端口索引] = [{ node: 目标节点名, type, index }]`。
  - `lmChatOpenAi` 的 `outputs = ["ai_languageModel"]`，`memoryBufferWindow` 的 `outputs = ["ai_memory"]`，`toolHttpRequest` 的 `outputs = ["ai_tool"]`
  - Agent v3.1 的 `inputs` 含 `ai_languageModel` / `ai_memory` / `ai_tool` / `ai_outputParser`
  - 所以「子节点的输出」连「Agent 的输入」→ 连接挂在子节点名下。这是 AI 子节点与普通节点的唯一区别：普通节点是「上游持有连接」同一个道理，只是 AI 端口类型不是 `main` 而已。

官方枚举值（`n8n-workflow@2.38.1` → `interfaces.d.ts`，`NodeConnectionTypes`）：

| 常量 | 字符串值 |
| --- | --- |
| `AiAgent` | `ai_agent` |
| `AiChain` | `ai_chain` |
| `AiDocument` | `ai_document` |
| `AiEmbedding` | `ai_embedding` |
| `AiLanguageModel` | `ai_languageModel` |
| `AiMemory` | `ai_memory` |
| `AiOutputParser` | `ai_outputParser` |
| `AiRetriever` | `ai_retriever` |
| `AiReranker` | `ai_reranker` |
| `AiTextSplitter` | `ai_textSplitter` |
| `AiTool` | `ai_tool` |
| `AiVectorStore` | `ai_vectorStore` |
| `Main` | `main` |

> 注意大小写：是 **`ai_languageModel`**（驼峰）、`ai_outputParser`、`ai_textSplitter`、`ai_vectorStore` —— 不是全小写。

### 完整可复制示例（Agent + Model + Memory + Tool）

```json
{
  "connections": {
    "Webhook": {
      "main": [[{ "node": "AI Agent", "type": "main", "index": 0 }]]
    },
    "OpenAI Chat Model": {
      "ai_languageModel": [[{ "node": "AI Agent", "type": "ai_languageModel", "index": 0 }]]
    },
    "Simple Memory": {
      "ai_memory": [[{ "node": "AI Agent", "type": "ai_memory", "index": 0 }]]
    },
    "HTTP Request Tool": {
      "ai_tool": [[{ "node": "AI Agent", "type": "ai_tool", "index": 0 }]]
    },
    "AI Agent": {
      "main": [[{ "node": "Respond to Webhook", "type": "main", "index": 0 }]]
    }
  }
}
```

三层结构逐层含义：`connections[源节点名]` → `[端口类型]` → `[输出索引]` → `[ { node: 目标节点名, type: 端口类型, index: 目标输入索引 } ]`。
即：`connections["OpenAI Chat Model"]["ai_languageModel"][0][0].node === "AI Agent"`。

**已在你们仓库中实测印证**：`workflows/00-llm-test.json` 与 `workflows/04-customer-insights.json` 里
`OpenAI Chat Model` 的 `connections` 就是 `ai_languageModel → AI Agent`，方向与上面一致。

来源：
- `n8n-workflow@2.38.1` → `dist/cjs/interfaces.d.ts`（`NodeConnectionTypes`、`IConnections`）
- `@n8n/n8n-nodes-langchain@2.38.2` → 各子节点 `outputs: [NodeConnectionTypes.Ai*]`；`AgentV3.node.js` 的 `builderHint.inputs`
- 仓库内既有产物：`workflows/00-llm-test.json`、`workflows/04-customer-insights.json`
- 文档：https://docs.n8n.io/advanced-ai/examples/understand-connections/

---

## 12. 【关键问题二】最小合法 node 对象形状

来源：`n8n-workflow@2.38.1` → `interfaces.d.ts` 的 `INode`。

| 键 | 类型 | 必需性 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | **类型上必需**（非 optional） | UUID。运行时构造 `Workflow` 时不校验，但**数据库/UI 需要唯一 id**；导入时缺失可能被补生成。**建议始终显式写。** |
| `name` | `string` | **必需** | 工作流内唯一，`connections` 全靠它引用；**重名会导致连接指向错乱** |
| `type` | `string` | **必需** | 完整限定类型名 |
| `typeVersion` | `number` | **必需** | 缺失时 n8n 会按 `currentVersion`（即 `defaultVersion` 或最大版本）兜底，**但行为随版本漂移，务必显式写** |
| `position` | `[number, number]` | **必需**（`INode.position` 非 optional） | UI 画布坐标；纯 API 执行时不影响逻辑，但缺失会让 UI 报错/重叠 |
| `parameters` | `INodeParameters` | **必需**（非 optional） | 无参数节点用 `{}`（如 NoOp） |
| `credentials` | `INodeCredentials` | 可选 | `{ [凭证类型名]: { id, name } }`；`INodeCredentialsDetails = { id: string\|null, name: string }` |
| `disabled` | `boolean` | 可选 | `true` 时该节点被跳过 |
| `notes` / `notesInFlow` | `string` / `boolean` | 可选 | 画布备注 |
| `retryOnFail` / `maxTries` / `waitBetweenTries` | `bool`/`number`/`number` | 可选 | 失败重试 |
| `alwaysOutputData` | `boolean` | 可选 | 无数据也输出一项 |
| `executeOnce` | `boolean` | 可选 | 只执行一次 |
| `onError` | `'stopWorkflow' \| 'continueRegularOutput' \| 'continueErrorOutput'` | 可选 | **`continueErrorOutput` 会给节点增加一个错误输出端口，影响 `connections` 索引** |
| `continueOnFail` | `boolean` | 可选 | 旧写法 |
| `webhookId` | `string` | 可选 | Webhook 节点用，导入时自动补齐 |
| `extendsCredential` | `string` | 可选 | — |

**实测补充**（用 `n8n-workflow@2.38.1` 的 `new Workflow({...})` 逐项删键跑）：
- `Workflow` 构造器**不会**因缺 `position` / `parameters` / `id` / `typeVersion` / `name` / `type` 而抛错 —— 即**解析层面很宽松**。
- 也**不会**因节点重名而抛错 —— 即**它不替你挡重名**，这是最容易被静默接受、运行期才炸的坑（你们的 `tools/validate-workflows.mjs` 已经自己查了这一点，很好）。
- 结论：**宽松 ≠ 合法**。`id/name/type/typeVersion/position/parameters` 六个键请一律显式写全。

最小骨架模板：

```json
{
  "id": "8f2a1c34-5b6d-4e7f-9a0b-1c2d3e4f5a6b",
  "name": "My Node",
  "type": "n8n-nodes-base.noOp",
  "typeVersion": 1,
  "position": [0, 0],
  "parameters": {}
}
```

顶层 workflow 对象（`IWorkflowBase`，导入所需子集）：

```json
{
  "name": "客服问题分流",
  "nodes": [],
  "connections": {},
  "settings": { "executionOrder": "v1" },
  "active": false
}
```

- `IWorkflowBase` 里 `id/name/active/isArchived/createdAt/updatedAt/nodes/connections/activeVersionId` 在类型上必需，
  但**通过 UI 的 "Import from File" 或 `POST /workflows` 导入时**，`id`、时间戳、`active`、`activeVersionId` 由 n8n 生成，
  所以**手工导出/生成的文件里通常只需 `name` + `nodes` + `connections` + `settings`**。
- `settings.executionOrder: "v1"` 建议显式写（v1 是 item-by-item 顺序执行，与 v0 的「按节点顺序跑完所有 item」语义不同）。
- `pinData` / `staticData` / `meta` / `versionId` 都可选。

来源：
- `n8n-workflow@2.38.1` → `dist/cjs/interfaces.d.ts`（`INode` @1125、`INodeCredentials` @1117、`INodeCredentialsDetails` @1108、`IWorkflowBase` @2749）
- 本地实测：`new Workflow(...)` 增删键对照
- 文档：https://docs.n8n.io/build/manage-workflows/export-and-import/

---

## 13. 【关键问题三】有没有官方 JSON Schema？

**结论：没有。需要明确标注 UNCONFIRMED / 否。**

- `n8n`、`n8n-nodes-base`、`n8n-workflow` 三个包内**都不包含** workflow 的 JSON Schema 文件
  （已全量搜索 `*.schema.json` / `workflow-schema*`，无命中）。
- n8n 的**导入路径不做 JSON Schema 校验**：`Workflow` 构造器如上所示对缺键、重名都静默接受。
  真正的校验发生在：
  1. **参数层面运行时校验** —— `@n8n/n8n-nodes-langchain` 里有一批 `@generated` 的 **Zod schema**（如
     `node-definitions/nodes/n8n-nodes-langchain/lmChatOpenAi/v13.schema.js`），以及 `n8n-workflow` 的
     `validateFilterParameter` / `type-validation`。这些是**逐节点、逐参数**的，不是整份 workflow 的 schema。
  2. **UI 导入时的前端校验**（节点类型是否存在、连接是否合法等），不是可下载的 schema。
- 社区有第三方 schema/校验器（如 `czlonkowski/n8n-mcp` 的 `validate_workflow`），**非官方**。
  其中一个已知缺陷正好和本文第 3 节相关：它漏检 IF v2.2+ / Switch v3.2+ 的 `conditions.options.version`
  （见 https://github.com/czlonkowski/n8n-mcp/issues/675 ）。
- 因此：**「手工生成 workflow JSON」没有官方 schema 可以兜底**，必须靠本文这种「对着真实节点定义核对」的方式，
  加上你们自己的 `tools/validate-workflows.mjs` 这类结构校验。

来源：
- 全量文件搜索（无命中）：`n8n-nodes-base@2.38.2`、`@n8n/n8n-nodes-langchain@2.38.2`、`n8n-workflow@2.38.1`
- Zod 逐节点 schema 实例：`@n8n/n8n-nodes-langchain@2.38.2` → `dist/node-definitions/nodes/**/v*.schema.js`
- https://docs.n8n.io/build/manage-workflows/export-and-import/

---

## 14. 如何使用本文（复核脚本）

本文每个值都能在 5 分钟内自己复现，做法**不依赖网络阅读源码**，而是直接读官方 npm 包里编译后的节点定义：

```bash
mkdir -p /tmp/n8nref && cd /tmp/n8nref
npm pack n8n-nodes-base@2.38.2
npm pack @n8n/n8n-nodes-langchain@2.38.2
npm pack n8n-workflow@2.38.1
tar xzf n8n-nodes-base-2.38.2.tgz -C base --one-top-level=base 2>/dev/null || tar xzf n8n-nodes-base-2.38.2.tgz
# 然后 grep defaultVersion / version：
grep -n "defaultVersion" */package/dist/nodes/**/*.node.js
```

或直接问 npm：
```bash
npm view n8n dist-tags          # latest / beta / rc
npm view n8n@2.38.6 dependencies --json | grep -E "nodes-base|langchain|n8n-workflow"
```

**换版本时的复核清单**（2.39.x 起只需重跑这几项）：
1. `npm pack` 新版本包 → 每个节点的 `defaultVersion` / `version` 数组
2. IF：`IfV2.node.js` 里 `typeOptions.filter.version` 的表达式（决定 `options.version` 取几）
3. Agent：`Agent.node.js` 的 `defaultVersion`，以及 V3 的 `builderHint.inputs` 连接类型
4. AI 子节点 `outputs`：确认 `ai_languageModel` / `ai_memory` / `ai_tool` key 未改名
5. `n8n-workflow` 的 `NodeConnectionTypes` 枚举

---

## 15. 与仓库现状的对接建议

| 节点 | 仓库 `build-workflows.mjs` 现值 | 2.38.2 当前默认 | 是否可用 | 建议 |
| --- | --- | --- | --- | --- |
| webhook | `2` | `2.1` | ✅ | 保持；`responseNode` 两者都支持 |
| respondToWebhook | `1` | `1.5` | ✅ | 保持；选项集一致 |
| if | `2.2` + `options.version: 2` | `2.3` | ✅ | **保持**（`2.2`↔`version:2` 配套正确）。若要升 `2.3`，**必须同时**把 `options.version` 改成 `3` |
| httpRequest | `4.2` | `4.5` | ✅ | 保持；POST JSON 写法与 `4.5` 相同 |
| noOp | `1` | `1` | ✅ | — |
| executeWorkflow | — | `1.3` | — | 新写时注意 `workflowId` 在 `≥1.1` 是 resourceLocator 形态 |
| agent | `3` | `3.1` | ✅ | 保持 `3`；`3.1` 的 `promptType` 去掉了 `guardrails` |
| lmChatOpenAi | `1.2` | `1.3` | ✅ | **保持 `1.2` 更省心**：`1.3` 默认 `responsesApiEnabled: true`，OpenAI-compatible 第三方端点可能不支持 |
| memoryBufferWindow | `1.3` | `1.4` | ✅ | 保持 `1.3`；`1.4` 引入了 scoped-session 行为变化 |
| toolHttpRequest | — | `1.1` | — | — |

> 一句话：**仓库现有 typeVersion 全部仍被 2.38.x 支持，不必为升级 n8n 而改动**。
> 唯一必须成对维护的是 IF 的 `typeVersion` ↔ `conditions.options.version`。

---

## 16. 更正与补充：仓库里 AI 节点的真实来源（2026-09-11 复核）

第 15 节的表格把 AI 节点的 typeVersion 归到了 `tools/build-workflows.mjs`，**这一点不准确**，
复核结果如下（证据：`grep -n "langchain" tools/build-workflows.mjs` 无命中；节点来自
`disabledOriginals()` 逐字搬用 `workflows/*.json` 蓝图 —— 见 `tools/build-workflows.mjs:252`）。

| 节点 | 真实来源 | 实际写死的值 | 2.38.6 是否支持 | 结论 |
| --- | --- | --- | --- | --- |
| `@n8n/n8n-nodes-langchain.agent` | `workflows/00-llm-test.json` 等蓝图 | `2` | ✅（`AgentV2.node.js` 存在） | 可用 |
| `@n8n/n8n-nodes-langchain.lmChatOpenAi` | 同上 | `1.3` | ✅ | 可用；注意 1.3 默认 `responsesApiEnabled: true` |
| `@n8n/n8n-nodes-langchain.toolHttpRequest` | `workflows/01-create-user-manager.json`、`03-proxmox-api.json` 等 | **`4.2`** | ❌ **不支持** | **必须修**：该节点版本表只有 `[1, 1.1]`，`4.2` 是 `n8n-nodes-base.httpRequest` 的版本号，显然是复制粘贴造成的 |

复核命令（可直接复现）：

```bash
# 1) build 脚本里根本没有 langchain 节点
grep -c 'langchain' tools/build-workflows.mjs        # → 0

# 2) 蓝图里 toolHttpRequest 的 typeVersion
grep -o '"typeVersion": *4\.2' workflows/*.json | wc -l

# 3) 该节点在 2.38.2 的真实版本表
curl -s https://cdn.jsdelivr.net/npm/@n8n/n8n-nodes-langchain@2.38.2/dist/nodes/tools/ToolHttpRequest/ToolHttpRequest.node.js \
  | grep -oE 'version: \[[^]]*\]'                    # → version: [1, 1.1]

# 4) Agent 确实保留了 v2
curl -s https://data.jsdelivr.com/v1/packages/npm/@n8n/n8n-nodes-langchain@2.38.2?structure=flat \
  | grep -o 'AgentV2.node.js'                        # → 有
```

**影响面**：这些节点在 `generated/*.json` 里都是 `disabled: true` 的"保留节点"，
所以线上 7 个 active 工作流不受影响。但 README 第 3 节写的是"配好凭证后启用即可"——
按那句话启用 `toolHttpRequest` 会得到一个版本号不存在的节点（界面显示 `?`、执行报
`Unrecognized node type`，与 README 第 6 节踩坑 #1 的症状一致，但成因不同）。
修法是在蓝图里把 `4.2` 改成 `1.1`（或 `1`），并重新生成。

**另一条对 Adapter 更重要的更正**：`Agent.node.js` 的 `builderHint` 明确写着
"Inside subnodes, reference upstream data with `nodeJson(triggerNode, 'path')`, not `$json`
— **subnodes do not share the main predecessor's item context**"。
所以 Graph → n8n Adapter 里 Memory 的 `sessionKey` 不能写成 `={{ $json.sessionId }}`，
必须显式引用 Trigger 节点：`={{ $('U::<triggerNodeId>::primary').item.json.sessionId }}`。
这一点已固化在 `lib/workflow-graph/adapter/n8n-v1.ts`，并且必须在克隆环境实测确认。
