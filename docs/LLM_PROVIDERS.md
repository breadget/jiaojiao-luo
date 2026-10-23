# 多家模型服务（用户自选）

更新时间：2026-09-12
适用范围：`lib/llm/providers.ts`、`lib/server/llm.ts`、`app/api/agent/chat/route.ts`、`app/api/workflows/agent/route.ts`、Studio / 使用端的模型面板

---

## 1. 支持的模型服务

一个 provider 同时描述「怎么调（协议）」「调哪里（端点）」「能选什么模型」。
注册表是**唯一事实源**，前端与后端都从这里取，不在别处硬编码。

| id | 名称 | 协议 | 默认端点 | 默认模型 | 需要 Key |
| --- | --- | --- | --- | --- | --- |
| `qwen`（默认） | 通义千问 · 阿里云百炼 | OpenAI 兼容 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 是 |
| `openai` | OpenAI | OpenAI 兼容 | `https://api.openai.com/v1` | `gpt-4o-mini` | 是 |
| `deepseek` | DeepSeek | OpenAI 兼容 | `https://api.deepseek.com/v1` | `deepseek-chat` | 是 |
| `moonshot` | Kimi · 月之暗面 | OpenAI 兼容 | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | 是 |
| `zhipu` | 智谱 GLM | OpenAI 兼容 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | 是 |
| `anthropic` | Claude · Anthropic | Anthropic Messages | `https://api.anthropic.com` | `claude-sonnet-4-5` | 是 |
| `gemini` | Gemini · Google | Gemini generateContent | `https://generativelanguage.googleapis.com` | `gemini-2.5-flash` | 是 |
| `ollama` | 本机 Ollama | OpenAI 兼容 | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` | 否 |
| `custom` | 自定义（OpenAI 兼容） | OpenAI 兼容 | 无（必须自填） | 无（必须自填） | 是 |

历史写法 `openai-compatible` 仍然认，等价于 `openai`（不带 Base URL 时就是 OpenAI 官方端点），
所以老草稿不会因为这次改动突然编不过。其他别名：`dashscope`→`qwen`、`kimi`→`moonshot`、
`glm`→`zhipu`、`claude`→`anthropic`、`google`→`gemini`。

**模型名永远可以手填**：下拉里的候选只是建议，服务商出新模型不需要改代码。

## 2. 用户在哪里选

| 位置 | 改什么 | 说明 |
| --- | --- | --- |
| Studio · 辅助 Agent（改画布用） | 模型服务 / API Key（Base URL、模型名收进「高级」） | 换服务时自动带出默认端点与默认模型，**已填的 Key 不会被清掉**；填完 Key 立刻可用，不要 Admin token |
| 使用端 · 自带模型 Key 面板 | 模型服务 / Base URL / 模型名 / Key | Key 只存在浏览器 localStorage，随请求发给服务端用完即弃，不落库 |
| Studio · Inspector 的 Model 节点 | 模型服务 / Model / Base URL | 决定这张图编译到 n8n 时用哪个服务 |

三处的选项都来自 `providerOptions()`，不存在“界面能选、后端不认”的错位。

### 2.1 两套 Agent 是两套配置，别混

| | 辅助 Agent（Studio 里那个对话框） | 工作流里的 Agent（画布上的节点） |
| --- | --- | --- |
| 干什么 | 读你的需求，生成/修改**画布**上的节点与连线 | 工作流真正执行时理解输入、调模型、决定分流 |
| 在哪配 | 面板里的「辅助 Agent 的模型服务」+ API Key（存浏览器 sessionStorage） | Inspector 的 `AI Agent` 节点 + 它连的 **Model 节点**（存 Graph） |
| Key 去哪 | 只发往所选服务商，用完即弃，**不进 Graph / D1 / 运行记录** | Graph 里只存服务名与模型名；运行时用执行方自己的 Key（使用端自带，或 n8n 挂的凭证） |
| 鉴权 | 同源浏览器请求 + 限流即可（不写库，所以不要 Admin token） | 由执行路径决定：使用端 `POST /api/agent/chat`，或 n8n webhook |

面板里还有一个「去改工作流里那个 Model 节点」按钮，直接跳到画布上对应的节点，
避免把“辅助 Agent 用的 Key”误当成“工作流跑起来用的 Key”。

## 3. 服务端怎么分发

`callChatModel()` 按 provider 的 `protocol` 走三条互不相同的请求形态：

| 协议 | 端点 | 鉴权 | 关键结构 |
| --- | --- | --- | --- |
| `openai-chat` | `{baseUrl}/chat/completions` | `Authorization: Bearer <key>` | `messages` 原样透传 |
| `anthropic-messages` | `{baseUrl}/v1/messages` | `x-api-key` + `anthropic-version: 2023-06-01` | `system` 提到顶层，`max_tokens` 必填 |
| `google-generate-content` | `{baseUrl}/v1beta/models/{model}:generateContent` | `x-goog-api-key` | `contents[].parts[].text`，system 走 `systemInstruction` |

响应解析也按协议各自取值（`choices[].message.content` / `content[].text` / `candidates[].parts[].text`），
统一归一成同一份 `{ ok, text, model }`，失败时归一成同一组错误码：
`LLM_NOT_CONFIGURED` / `LLM_UNSUPPORTED_PROVIDER` / `LLM_ERROR` / `LLM_TIMEOUT` /
`NETWORK_ERROR` / `RATE_LIMITED` / `UPSTREAM_ERROR`。

**不静默兜底**：用户选了认不出的服务，直接 400 `LLM_UNSUPPORTED_PROVIDER`；
自定义服务没填 Base URL、模型名为空、上游返回 2xx 但内容不是模型回答，都是明确错误，
不会换成默认服务重试，也不会伪装成成功。

## 4. 安全边界（沿用并加强既有规则）

1. **BYO Key**：Key 由用户自带，服务端只透传，不写 D1、不进运行记录、不进 Graph。
2. **Key 只进请求头**：三种协议都不把 Key 放进 URL 查询参数（有测试守着）。
3. **https-only**：非 `https` 的 Base URL 一律拒绝，只有本机回环（`127.0.0.1` / `localhost` / `::1`）例外，
   用于 Ollama 这类本机模型。
4. **Graph 里只能有服务名与模型名**：`Model` 节点保存 `provider` / `model` / 可选 `baseUrl`，
   不保存任何凭据；编译产物只带凭据**引用名**（`openAiApi`），由运维在 n8n 侧挂载。

## 5. 编译到 n8n 的边界

Adapter v1.1 **只产出已验证过 typeVersion 的节点**，所以模型节点统一编译成
`@n8n/n8n-nodes-langchain.lmChatOpenAi`（1.3），并按所选服务补上它的 OpenAI 兼容端点：

| 选择 | 编译结果 |
| --- | --- |
| `qwen` / `deepseek` / `moonshot` / `zhipu` | `lmChatOpenAi` + `options.baseURL = 该服务兼容端点` |
| `openai` / 历史的 `openai-compatible` | `lmChatOpenAi`（不显式写 baseURL，即官方端点） |
| `anthropic` / `gemini` | `lmChatOpenAi` + 厂商官方提供的 OpenAI 兼容端点 |
| `custom` | `lmChatOpenAi` + 用户在 Graph 里填的 baseUrl（缺了直接报错） |

也就是说：**站点直连支持厂商原生协议；n8n 侧走各家官方 OpenAI 兼容端点**，
同一条工作流两种执行路径都能用同一把 Key。原生协议目前没有对应的 n8n 节点映射，
这是有意为之——不猜未经验证的 `typeVersion`。

## 6. 新增一家服务要改什么

只改 `lib/llm/providers.ts`：往 `llmProviders` 里加一条（id / 协议 / 端点 / 模型候选 / 是否需要 Key）。
如果这家只有原生协议（既不是 OpenAI 兼容、也不是 Anthropic/Gemini 形态），
再在 `lib/server/llm.ts` 加一个 `buildXxxPlan()`，并补一条协议测试。

## 7. 尚未覆盖

- 上述服务的端到端真实调用都需要用户自己的一次性 Key，本仓库默认不跑真实调用
  （与 `QWEN_BYO_KEY_MATRIX.md` 的口径一致）。
- 使用端把模型配置发给 **n8n 绑定工作流** 时，信封仍按 v1 协议只带 `baseUrl` / `model`；
  免 Key 的本机模型目前只在直连路径可用，走 n8n 时仍要由 n8n 侧挂凭证。
- 模型候选列表会过期（厂商改名很快），界面允许手填，遇到报错以厂商控制台为准。
- 没有新增公开的“服务目录”HTTP 接口：前端与服务端共用同一个注册表模块，
  少一个对外接口就少一份攻击面；如果以后要让外部客户端自助发现服务，再加只读的 catalog 路由。
