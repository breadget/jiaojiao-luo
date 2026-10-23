> **来源与贡献：** 本分支由 [@breadget](https://github.com/breadget) 导入和维护，包含协作或第三方成果；历史作者与许可见 [ATTRIBUTION.md](ATTRIBUTION.md)。新的提交记录表示导入与维护，不代表全部代码为个人独立原创。

# Urtoris × n8n：可复用、可观测、可恢复的 Agent 工作流架构

网站（Urtoris）通过**一套统一协议**调用任意 n8n 工作流；n8n 侧拆成
**入口网关 + 公共子工作流 + 全局错误处理**，任何一个节点挂掉都能定位到具体节点。

- 协议契约：[`docs/PROTOCOL-v1.md`](docs/PROTOCOL-v1.md)
- 运维手册（部署 / 排错 / execution 清理 / 回滚）：[`docs/OPERATIONS.md`](docs/OPERATIONS.md)

```
浏览器 / 外部程序
      ▼
Urtoris @127.0.0.1:3000     ← 生成 requestId、统一信封、重试、超时、落库
      ▼  POST /webhook/urtoris/<workflow>   （Bearer 鉴权）
n8n @127.0.0.1:5678
      ├─ urtoris-gateway                 统一入口，按 workflowId 转发
      ├─ urtoris-wf-llm-smoke            W1  Agent LLM 连通性冒烟
      ├─ urtoris-wf-user-manager         W2  建用户：AI 主管 Agent
      ├─ urtoris-wf-security-analysis    W3  安全分析：IP/域名情报
      ├─ urtoris-wf-api-gateway          W4  API 网关：HTTP 方法路由
      ├─ urtoris-wf-customer-insights    W5  客户洞察：评论聚类 + AI 总结
      ├─ common-auth / common-llm / common-envelope / common-log   公共子工作流
      └─ urtoris-global-error-handler    全局 Error Workflow（所有工作流都绑了它）
      ▼
Urtoris /api/n8n/events      ← 按 requestId 反查每一步
```

**服务器**：阿里云 ECS `8.133.252.143`（2C / 1.6G）
n8n 界面 `http://8.133.252.143/`（nginx 反代 `127.0.0.1:5678`）｜站点 `127.0.0.1:3000`（域名受备案限制，见本文末）

---

## 1. 已交付的六件事

| # | 能力 | 落地位置 | 验证方式 |
| --- | --- | --- | --- |
| 1 | **统一 v1 请求/响应协议** | `lib/server/protocol.ts`（网站侧）+ `generated/*.json`（n8n 侧） | A 组 5 条用例 |
| 2 | **requestId / sessionId 全链路贯穿** | 网站生成 → 请求体 + HTTP 头 → n8n → 子工作流 → 落库 `runs.request_id` | A5 + D6 + E2 用例 |
| 3 | **全局 Error Workflow** | `generated/urtoris-global-error-handler.json`，通过 `settings.errorWorkflow` 绑到全部工作流 | E 组 3 条（含故障注入 + 双向补链） |
| 4 | **拆公共 Sub-workflow** | `common-auth` / `common-llm` / `common-envelope` / `common-log`，由 `Execute Sub-workflow` 调用 | 每个业务工作流都引用它们 |
| 5 | **5 个工作流真实绑定 + 端到端跑通** | 站点 `wf_n8n_*` 五个工作流各绑一个真实 webhook | B 组 13 条 + D 组 5 条 |
| 6 | **Webhook 鉴权 + execution 数据控制** | Header Auth 加密凭证；`EXECUTIONS_DATA_*` 比官方默认更激进 | A 组 2 条 + 第 6 节 |

端到端验收：**40 / 40 通过**（`node tools/smoke-test.mjs`，跑在真实 ECS 上、真实 HTTP）。

---

## 2. 目录结构

```
docs/PROTOCOL-v1.md          协议契约（唯一来源）
docs/OPERATIONS.md           运维手册：部署、排错、清理、回滚、故障处置表
docs/N8N-NODE-REFERENCE-2.38.md  n8n 2.38.6 节点定义速查（版本表的出处与复核脚本）
tools/build-workflows.mjs    工作流生成器 —— 改一处，5 个工作流同时升级
tools/validate-workflows.mjs 导入前的结构校验（挡住 n8n 静默接受的非法连接）
tools/n8n-node-versions.mjs  n8n 2.38.6 的节点版本表（从官方包内实测，不是文档推测）
tools/test-node-versions.mjs 节点版本回归测试（19 条断言，部署前必跑）
tools/test-execution-binding.mjs 前置绑定、网关转发与 fail-closed 结构回归
tools/test-mode-semantics.mjs W1/W2/W5 的 mode / degraded 协议回归
tools/deploy-n8n.mjs         n8n 侧部署：生成→校验→上传→备份→导入→发布→核对
tools/deploy-urtoris.mjs     网站侧部署：同步源码 + 在服务器上重建（先停 n8n 腾内存）
tools/seed-urtoris.mjs       把 5 个工作流登记进站点并绑定 webhook
tools/smoke-test.mjs         40 条端到端验收
tools/remote/*.py            在 ECS 上执行的部署/验收脚本（纯标准库，无需 pip）
generated/                   生成产物（workflows JSON + manifest）
workflows/                   最初的 4 个模板蓝图（保留作参考与 disabled 节点来源）
```

**为什么用生成器而不是手写 JSON**：协议层（鉴权 / 校验 / 信封 / 日志）在每个工作流里必须逐字一致，
手写必然漂移；工作流 id 是硬引用（`settings.errorWorkflow`、`Execute Sub-workflow`），
字符串常量集中定义才不会写错。改 `tools/build-workflows.mjs` 一处，重新生成即可。

---

## 3. 五个工作流各自"真"在哪

不是"看起来像 Agent"，每一步都是真实往返：

| 工作流 | 真实做的事 | 需要凭证？ |
| --- | --- | --- |
| **W1** Agent LLM 冒烟 | 真实调用 OpenAI 兼容接口（`common-llm` 子工作流） | BYO Key；没 Key 返回诚实的规则自检，`mode=rules`、`degraded=true` |
| **W2** 建用户 · AI 主管 | 真实解析资料 → 模型判定职级 → 分支动作；**没 Key 自动退回规则判定** | BYO Key 可选 |
| **W3** 安全分析 | 真调 `ip-api.com`（归属/ASN/代理/机房标记）+ `223.5.5.5`（真实 DNS）+ `rdap.org`（真实注册时间），自动算风险分 | 不需要 |
| **W4** API 网关 | 按 GET/POST/DELETE 真实转发到上游并取回响应 | 不需要 |
| **W5** 客户洞察 | 真实 K-means（k-means++ / 3 种子取最优 / 25 轮）聚类 24 条评论 → 模型总结；**没 Key 退回按簇规则建议** | BYO Key 可选 |

W1 / W2 / W5 的无 Key 路径都可以成功完成，但信封一定明确标记
`mode: "rules"`、`degraded: true`；真实模型路径标记 `mode: "llm"`、
`degraded: false`。因此“工作流执行成功”不会被误报成“真实 AI 已成功”。

原始蓝图里依赖 Slack / Jira / Entra ID / Postgres / GitHub / VirusTotal / Google Sheets / Proxmox 的节点
**全部以 `disabled` 形式保留在画布左下角**（命名前缀 `[保留·未启用]`），配好凭证后启用即可，协议层与业务逻辑都不用动。

---

## 4. 快速开始

```bash
# 只改工作流
node tools/build-workflows.mjs && node tools/validate-workflows.mjs && node tools/deploy-n8n.mjs

# 改网站代码
node tools/deploy-urtoris.mjs

# 全量验收
node tools/smoke-test.mjs
```

令牌首次运行时自动生成到 `.secrets.json`（600 权限，已 gitignore）；轮换就删掉它再跑 `deploy-n8n.mjs`。

生成器默认面向同机部署（n8n `127.0.0.1:5678`、站点事件入口
`127.0.0.1:3000`）。隔离 Canary 或容器拓扑可在**生成时**设置
`URTORIS_N8N_INTERNAL_BASE_URL` 与 `URTORIS_EVENTS_URL`；两者只接受无内联凭据、
无 query/hash 的 HTTP(S) URL，最终值会写进 `generated/manifest.json` 供验收。

---

## 5. BYO Key：密钥不进 n8n

使用端界面填的模型 Key **随请求透传**（`context.llm = { apiKey, baseUrl, model }`），
n8n 不把它写进凭据库，但它会经过执行 item。当前生产基线 2.35.7 为避免成功执行
永久卡在 running，必须保存成功执行数据，因此**升级验收前只能用一次性测试 Key，
不要投入生产 Key**。2.38.6 的隔离 `none` 专项已通过，完整证据与迁移门槛见运维手册第 6 节。

想让 n8n 自己持有 Key 也可以：在 `common-llm` 的「调用模型」节点上挂一个凭证即可，5 个工作流一次生效。

---

## 6. 踩过的坑（都会复现，别删）

这些都是实际调试中花过时间的，`tools/validate-workflows.mjs` 已经能自动挡住其中大部分：

1. **节点类型前缀**：基础节点是 `n8n-nodes-base.`（不带 `@n8n/`），只有 LangChain 节点带 scope。
   写错的表现极具误导性 —— `n8n import:workflow` **照常报 "Successfully imported"**，
   但界面上所有节点显示成 `?`，激活时报 `Unrecognized node type`，webhook 永远注册不上。
2. **Code 节点的 `language` 必须是 `javaScript`**（大写 S）。写成 `javascript` 会在运行时抛
   `Unsupported language: javascript`，报错位置在 Code 节点里，很难联想到拼写。
3. **Switch v3 每条规则的 `conditions` 必须是过滤器对象**（`{options, conditions: [...], combinator}`），
   不是 V1 那种裸条件。写错**不报错**，但所有项都会落到 output 0 —— 表现为"分流没生效、两个分支跑同一份数据"。
4. **Switch 的 `fallbackOutput` 必须是数字**（`-1` = None），传字符串 `'none'` 会被当成非法值。
5. **HTTP 节点对非 `application/json` 的响应把结果放在 `data`（字符串）而不是 `body`**。
   RDAP 返回 `application/rdap+json` 就踩了这个；要么显式 `responseFormat: 'json'`，要么在 Code 里两种都处理。
6. **取了 `fullResponse` 的 HTTP 节点会替换当前 item**（变成 `{body, headers, statusCode}`），
   下一个节点就用不了 `$json.target` 这类上游字段了 —— 需要的话别取 fullResponse，或者显式带回来。
7. **`$env` 在 n8n 2.x 的表达式/Code 节点里读不到**。令牌一律用加密凭证，不要写 `{{ $env.XXX }}`。
8. **用 CLI 改 `active` 不会注册 webhook**。n8n 2.x 有独立的发布流程，必须走
   `POST /rest/workflows/{id}/activate`（等价于界面点 Publish）；`deploy-n8n.mjs` 已经这么做。
9. **发布顺序有依赖**：被引用的子工作流必须先发布，引用它的工作流才能发布。
10. **n8n REST 的会话 cookie 带 `Secure`**，用 Python 的 `cookiejar` 走 `http://127.0.0.1` 会被拒绝回传
    （curl 不会）。部署脚本是手工抓 `Set-Cookie` 再回填的。
11. **AI 子节点连线方向**：`ai_languageModel` 等连线必须存在**子节点**上、指向 Agent，反过来是错的。
12. **在 2C/1.6G 机器上直接 `npm run build` 会整机失联**（内存耗尽触发 swap 抖动，SSH 都进不去）。
   `deploy/rebuild-safe.sh` 先停 n8n、限制 node 堆大小再构建，必须走它。

---

13. **typeVersion 写错，n8n 是静默的**。它只在界面上把节点显示成 `?`，运行时才报
    `Unrecognized node type`。2026-09-11 一次性查出 6 个：`toolHttpRequest` 被写成 `4.2`
    （那其实是 `httpRequest` 的版本，该节点只有 `1 / 1.1`）、`github` 与 `githubTrigger`
    写成 `2`、`lmChatGoogleGemini` 写成 `1.2`、`lmChatGroq` 写成 `1.3`、
    `outputParserAutofixing` 写成 `1.2`。这些都在 `disabled` 的保留节点里，
    所以一旦按第 3 节说的"配好凭证后启用"就会踩到。
    现在 `tools/validate-workflows.mjs` 用 `tools/n8n-node-versions.mjs` 挡住，
    `tools/test-node-versions.mjs` 逐条守回归。**换 n8n 版本后必须重核这张表。**

14. **绑定上报里的 `requestId` / `workflowId` 必须取校验结果，不能取 Webhook 原始 item**。
    Webhook 节点的输出是 `{ headers, params, query, body, ... }`，请求体在 `body` 里 ——
    如果上报节点直接挂在 Webhook 之后，裸写 `$json.requestId` 永远是 `undefined`，
    fail-closed 闸门会把所有工作流焊死在 `BINDING_FAILED`。
    现在的顺序是 **Webhook → 校验请求 → 请求合法? → 绑定执行（上报）**，
    上报节点的 `$json` 已经是校验节点的成功输出 `{ ok:true, requestId, payload, … }`，正确写法就是
    `requestId: $json.requestId`、`workflowId: $json.payload.workflowId`（`payload` 是原始协议体，
    里面的 `workflowId` 是**站点侧**的 `wf_n8n_*` id）。
    **不要**给 requestId 加 `'unknown'` 之类的兜底，**也不要**写死 n8n 侧工作流 id ——
    写死会把另一套 id 命名空间塞进 `n8n_execution_map.workflow_id`，站点会直接拒绝未知工作流 id。
    这两条现在是 `tools/binding-graph.mjs` 里 `bindingTopologyProblems` 的结构校验项。
    顺序同样不能反过来：requestId 缺失必须在校验闸门就判死（false 分支 → 组装错误 → `VALIDATION_ERROR`），
    **绝不**带着空 requestId 去调站点 `/api/n8n/events`。

    当前生成结果一共 11 个工作流：**5 个 prebound**（5 个 `urtoris-wf-*` 业务工作流）
    \+ **6 个 legacy**（4 个 `common-*`、全局错误处理、`urtoris-gateway`）。
    `urtoris-gateway` 刻意不做前置绑定：它只是转发器（`Webhook → 解析路由 → 路由有效?`），
    没有协议校验链，且真正执行业务的是目标工作流自己那次执行 ——
    给网关绑 `executionId` 会让 `runs.execution_id` 指向调度器执行而不是真实业务执行。
    网关对外仍接收短 key（如 `customer-insights`），但转发前会把
    `payload.workflowId` 改成站点 id（如 `wf_n8n_customer_insights`），否则目标工作流
    的提前绑定会被站点以 `BINDING_UNKNOWN_WORKFLOW` 拒绝。

15. **`neverError` 只兜住「非 2xx」，兜不住连接失败**。HTTP 节点上 `neverError: true` 时，
    响应码 4xx/5xx 不会抛，但 `ECONNREFUSED` / 超时仍然会抛并中断执行。
    绑定上报节点必须同时挂 `onError: 'continueRegularOutput'`，否则站点连不上时会直接抛错，
    绕过 Respond to Webhook（站点收到 n8n 的 500，而不是 `BINDING_FAILED` 信封），
    危险节点虽然没跑，但协议形状被破坏了。

16. **网关转发 HTTP 的错误输出必须接回响应归一节点**。`continueErrorOutput` 会把
    `ECONNREFUSED` / timeout 放到 output 1；若只连接 output 0，Webhook 会返回
    `HTTP 200` 但 body 为空。当前生成器把成功和错误两个输出都接到
    `透传子工作流信封`，连接错误会归一成 `UPSTREAM_ERROR`，不再产生空响应。

## 7. 域名 / HTTPS：已确认卡在阿里云边缘，签证书解决不了

**结论先说：不要去做 certbot。** 2026-09-10 实测的证据链：

| 测试 | 来源 | 结果 |
| --- | --- | --- |
| `HTTP` + `Host: urtoris.cn` | 外部直连 IP | `403 Non-compliance ICP Filing`（阿里云注入的拦截页） |
| TLS + `SNI=urtoris.cn` | 外部直连 IP | 收到 ServerHello **0 字节**（ClientHello 被丢弃） |
| TLS + `SNI=n8n.urtoris.cn` | 外部直连 IP | 同上，0 字节 |
| TLS **不带 SNI** | 外部直连 IP | ✅ `subject=/CN=urtoris.cn`，握手正常 |
| nginx 本机 443 | ECS 内部 | ✅ HTTP 200 —— nginx 完全正常 |
| 第三方代理抓 `https://n8n.urtoris.cn` | Cloudflare / codetabs 独立网络 | `522 Connection timed out` |

**为什么签证书没用**：浏览器访问 HTTPS 一定会发 SNI，而带该域名的 SNI 在到达 nginx **之前**
就被阿里云边缘丢弃。所以即使拿到并装好 `n8n.urtoris.cn` 证书，`https://n8n.urtoris.cn` 依然打不开。
同理 `tls-alpn-01` 也过不了（Let's Encrypt 校验时同样发 SNI）。

**当前可用入口**：纯 IP `http://8.133.252.143/`（nginx `listen 80 default_server` 反代到 `127.0.0.1:5678`）。
nginx 443 上的 `urtoris.cn` vhost 保留着，但外网同样打不通。

### 要拿到正式 HTTPS 域名，只有三条路（都不是改配置能解决的）

1. **给域名做 ICP 备案**（根治，但要走 3–20 个工作日）
2. **把入口迁到香港 / 海外 ECS**（新机器 + 迁移）
3. **用已经备案或可访问的公网反向代理 / 隧道做入口**（例如把域名 NS 托管到 Cloudflare 走 Tunnel，
   ECS 侧只需要能出网 —— 实测 ECS 能访问 `api.cloudflare.com`，这条技术上可行）

> 阿里云 DNS 里可能残留两条 `_acme-challenge.n8n` 的 TXT 记录（本轮 DNS-01 的产物）。
> 服务器上没有阿里云 AccessKey，脚本删不了，需要人工在控制台删除。删掉不影响任何现有服务。

---

## 8. 下一步（按性价比排序）

1. **把 Key 填进去**：在网站使用端点「自带模型 Key」，W1/W2/W5 立刻从"可用"变成"真实模型驱动"。
2. **会话 Memory**：`sessionId` 已经全链路打通，接一个 n8n 的 Postgres/Redis Chat Memory 子工作流即可多轮。
3. **Tool Calling**：把 W3 的情报能力包成 HTTP Request Tool 挂到 Agent 上，让 Agent 自己决定查不查。
4. **前端 Dashboard**：`runs` + `n8n_events` 两张表已经能支撑"每一步执行状态"的可视化。
5. **Queue Mode**：等升级到 4C8G 再说，现在上就是给自己制造事故（判据见运维手册第 8 节）。
