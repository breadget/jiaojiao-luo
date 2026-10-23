# 变更说明：wf_demo_triage「客户请求分流」→ 带会话记忆的智能客服工单分流

状态：**可保存的 Graph 草稿 + Adapter v1.1 编译预览**。这些文件不代表任何
D1 环境的当前 revision/发布指针；**没有导入或激活任何 n8n 实例**，产物里没有任何凭据。

## 1. 目标链路

```text
Webhook Trigger（sessionId / question / channel / urgency）
        │ main
        ▼
AI Agent「AI 分析工单」 ──分类 / 优先级 / 摘要 / 建议动作──┐
        │ main.out                                          │ model
        ▼                                                   ▼
Condition「判断优先级」                     Qwen Model（qwen-plus）
   │ true（priority=high）      │ false（其余）   ▲ memory
   ▼                            ▼                 │
Output：需要人工立即处理   Output：回传到使用端   Window Memory
（人工升级，不自动执行）   （自动处理建议）      （按 sessionId 隔离）
```

## 2. 保留（复用现有节点 id 与连线）

| 现有节点 / 连线                                                    | 处理                                                                                                            |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `node_step_intake`（Webhook Trigger / 读取客户请求）               | 保留，id、位置、`legacyStepId` 不变；请求体契约写进 description                                                 |
| `node_step_summary`（AI Agent）                                    | 保留，id 与资源连线不变；补上结构化输出指令与 `fallbackPolicy: "error"`                                         |
| `node_step_priority`（Condition）                                  | 保留，id 与 `legacyStepId` 不变；表达式改为读 Agent 的 `priority`                                               |
| `node_step_return`（Output / 回传到使用端）                        | 保留，id 不变；承接 `branch.false`（普通优先级 → 自动处理建议）                                                 |
| `node_step_summary_model`（Qwen Model）                            | 保留，id、位置不变；显式 `provider: qwen`、`model: qwen-plus`                                                   |
| `node_step_summary_memory`（Memory）                               | 保留，id、位置不变；显式 `provider: window`、`maxTurns: 12`、Graph 里的 `sessionKey` 仅保存字段路径 `sessionId` |
| 连线 `condition.branch.false → node_step_return`                   | **原样保留**（端口、方向、id 都不变）                                                                           |
| 连线 `agent.resource.model → 模型`、`agent.resource.memory → 记忆` | 原样保留                                                                                                        |

## 3. 新增

| 新增                                                 | 说明                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `node_human_escalation`（Output）                    | 高优先级专用出口，名称「输出：需要人工立即处理」，不接任何执行类节点 |
| 连线 `agent.main.out → condition.main.in`            | Agent 的结构化结果进入 Condition                                     |
| 连线 `condition.branch.true → node_human_escalation` | 高优先级分支                                                         |
| 连线 `trigger.main.out → agent.main.in`              | Webhook 直接喂给 Agent（由原来的 `trigger → condition` 改写）        |

## 4. 刻意改变的地方（及原因）

1. **Condition 从 Agent 之前移到 Agent 之后。** 原来 `condition → agent`，优先级只能靠 Webhook 的
   `urgency` 猜；现在按需求由模型给出 `priority`，所以顺序是 `agent → condition`。
   两条相关连线被改写（不是删除节点）：`trigger→condition` 改成 `trigger→agent`，
   `condition.branch.true` 从指向 Agent 改成指向人工出口。
2. **`fallbackPolicy` 由 `rules` 改为 `error`。** 需求 6：模型失败必须报明确错误，
   不允许降级成规则结论冒充成功。
3. 现有 Output 节点改名「回传到使用端（自动处理建议）」，语义与它原本承接的
   `branch.false`（直接回传）一致。

## 5. 没有搬过来的旧节点（各一句原因）

| 旧节点                                                   | 原因                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `node_step_0117af28`（Legacy 步骤「新步骤」，transform） | Adapter v1.1 对 `transform` 没有 n8n 映射，留着会让编译预览直接失败（error），且它不在本次链路里 |
| `node_step_summary_http_tool`（HTTP Tool 占位）          | legacy 投影自动生成、`url` 为空，Adapter 会报「HTTP Tool 需要 config.url」                     |
| `node_step_summary_robot_tool`（Robot Control 占位）     | `implementation: "robot"` 不在 Adapter v1.1 支持范围，会直接编译失败                             |

这三项都**不是**被静默丢弃：id 与原因记在 Graph 的 `extensions.droppedPlaceholderNodeIds`
与 `extensions.droppedReason` 里。旧版步骤列表 `workflows.draft_steps_json` 也**一个字都没改**，
所以「新步骤」仍然留在旧步骤清单里，需要时补真实 URL / 动作清单就能加回画布。

## 6. 需求逐条对照

| #   | 要求                                                  | 落地方式                                                                                                                                                             |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 保留 Webhook Trigger 与 Output                        | `node_step_intake`、`node_step_return` 的原 id 与端口都保留（另加一个高优先级 Output）                                                                               |
| 2   | Webhook 收 sessionId / 用户问题 / 来源渠道 / 紧急程度 | Trigger 的 description 写明 `{ sessionId, question, channel, urgency }`，Agent 的 prompt 表达式逐字段取值                                                            |
| 3   | Qwen Model + Window Memory，记忆按 sessionId 隔离     | `node_step_summary_model`（`provider=qwen`、`qwen-plus`）+ `node_step_summary_memory`（`provider: window`，Graph 仅存 `sessionKey=sessionId`；Adapter 确定性重绑定） |
| 4   | AI Agent 输出分类 / 优先级 / 摘要 / 建议动作          | systemMessage 固定 JSON 契约：`classification` / `priority` / `summary` / `suggestedAction`                                                                          |
| 5   | Condition 分流两条输出                                | `branch.true → 输出：需要人工立即处理`；`branch.false → 回传到使用端（自动处理建议）`                                                                                |
| 6   | 模型失败返回明确错误，不伪装成功                      | `fallbackPolicy: "error"`；指令里也写明「模型不可用或无法判断必须报错，不许退化成固定规则结论」                                                                      |
| 7   | 保留可复用的现有节点与连线                            | 见第 2 节；只有 3 个投影占位节点没搬，原因见第 5 节                                                                                                                  |
| 8   | 配置 / URL / 参数里不写凭据                           | 草稿里没有任何 Key、密码、token；只有凭据**引用名**（编译预览里体现为 `headerAuth` / `openAiApi`，由运维挂载）                                                       |
| 9   | 只生成草稿，不发布 / 不激活 / 不导入 n8n              | `compile-preview.n8n.json` 是 `active:false` 的去凭据、只读编译结果                                                                                                  |

## 7. 验证证据（本地实测）

```text
payload-shape-ok        true                      # isWorkflowGraphPayload
credential-material     none                      # findCredentialMaterial 全图扫描
validate                 []                       # validateGraph：0 error / 0 warning
compile-ok              true                      # compileGraphToN8n(version=1)
compile-issues          12 warning / 0 error      # 见下
credential-refs         ["headerAuth","openAiApi"] # 只是引用名，产物里没有凭据本体
stats                   internal 7 / external 10 / connections 9 / unsupported 0
compiled active         false
adapter-version         1.1.0
graph-hash              119353c9038a48e0995b817fb430942ae5e4cc0571367586b5008acca855234e
compiled-hash           bc0dbbb3e749e8245c7a2415219465d839e2589d0744ae637a5b6f15eaac043f
```

编译预览里的分支接线（已核对）：

```text
U::node_step_intake::primary main[0] → U::node_step_intake::input            # 展平 Webhook body
U::node_step_priority::primary main[0] → U::node_human_escalation::envelope  # true
U::node_step_priority::primary main[1] → U::node_step_return::envelope       # false
U::node_human_escalation::envelope → U::node_human_escalation::primary       # urtoris.v1
U::node_step_return::envelope → U::node_step_return::primary                 # urtoris.v1
U::node_step_summary_memory::memory ai_memory → U::node_step_summary::primary
U::node_step_summary_model::model ai_languageModel → U::node_step_summary::primary
```

12 条 warning 都不是错误：8 条是 Studio 专用的 `legacyStepId` / `legacyStepKind`
不会进 n8n 产物；2 条提醒 Header Auth 与 Chat Model 凭证需要在导入环境时
**手工挂载**；1 条记录 Qwen 的 OpenAI 兼容端点；1 条要求 Memory 的子节点表达式
在克隆环境复验。这些静态文件不声明任何 D1 环境的当前 revision 或发布指针。

## 8. 已知限制（没有假装做到的部分）

1. **`fallbackPolicy: "error"` 已编译为 Agent 节点的 `onError: "stopWorkflow"`**；
   非法值会 fail closed。但 n8n 失败执行如何映射成站点的失败 run，仍需在生产数据克隆上
   跑真实 Qwen 错误分支确认。
2. **两个 Output 都会生成 `urtoris.v1` 成功信封**，并用 `outputNodeId` /
   `outputNodeName` 区分人工升级与自动建议出口。这不等于已有节点事件上报。
3. **Memory 的 Graph 配置只存 `sessionId`**，Adapter 把它重建为
   `$('U::node_step_intake::input').first().json.sessionId`。表达式构造与 Code 节点逻辑已有测试，
   但 AI 子节点的实际取值与跨 session 隔离仍要在 n8n 2.38.6 克隆环境实测。
4. 这份产物**没有真实 n8n 执行证据**；上面的结论来自类型守卫、validator、
   Adapter 编译、golden 回归和可执行 Code 节点单测。
5. Graph 与旧 `WorkflowStep[]` 仍不是原子双写；Studio 保存时会先存 Graph，再写兼容元数据，
   中间失败会显式报错，但不是单个跨表事务。
6. Studio 载入顺序是「浏览器 localStorage 草稿 > 服务端草稿」。如果这台机器的浏览器里存过
   `wf_demo_triage` 的旧本地草稿，会先看到旧图；清掉该 localStorage 项（或先把它保存到服务器）
   再刷新，就会看到这份新草稿。
7. Adapter 产物仍没有 `execution.bound` 和逐节点事件上报；仅有 bindings 不会产生事件，
   所以 Deploy 继续锁定。
