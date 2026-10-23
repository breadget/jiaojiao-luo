# Workflow Studio 架构分析

> 基线：`main@c0c1302`，2026-09-11。
>
> 本文是 Workflow Studio 第一阶段的架构基线。2026-09-11 评审通过后已实现首个 MVP：新增 `/studio`、Internal Graph 类型/校验、Graph 草稿 API 与 `0007_workflow_graph.sql`；随后的增量补上了 n8n Adapter v1、不可变发布快照与真实运行事件流（游标轮询），状态见 [WORKFLOW_GRAPH_RELEASE.md](WORKFLOW_GRAPH_RELEASE.md)。详细字段、界面和迁移步骤分别见 [WORKFLOW_SCHEMA.md](WORKFLOW_SCHEMA.md)、[WORKFLOW_UI_DESIGN.md](WORKFLOW_UI_DESIGN.md) 与 [MIGRATION_PLAN.md](MIGRATION_PLAN.md)。

## 实施增量（2026-09-11）

- `app/studio/page.tsx` 与 `components/studio/workflow-studio.tsx` 提供三栏画布、节点库、Inspector 和执行面板。
- `lib/workflow-graph/` 实现 Graph V1、Node Registry、legacy projector、连接约束和 DAG 校验。
- `GET/PUT /api/workflows/:id/graph` 提供管理员保护的草稿读取/保存、大小限制、敏感字段拒绝和 revision 冲突处理。
- `workflow_graph_drafts`、`workflow_versions`、`workflow_node_bindings` 已以 add-only 迁移建表；目前只有草稿表进入运行路径。
- 首页创建端保留兼容能力，并提供进入 Workflow Studio 的入口。
- Studio 的 Deploy 明确保持锁定；Run binding 调用旧发布绑定，并轮询真实节点遥测
  （只有存在 Graph 发布版本与 `workflow_node_bindings` 时节点才会点亮，否则运行面板
  明确显示"无节点绑定"，不会用动画假装观测过当前 Graph）。

## 决策摘要

- Urtoris 自己的 `WorkflowGraph` 将成为工作流设计的唯一事实源；React Flow 只负责交互，n8n JSON 只负责运行。
- n8n 继续作为执行引擎，不在本轮重写，也不让前端组件读取或生成 n8n 内部 JSON。
- 现有 `WorkflowStep[]` 不是实际 n8n 图，只是线性说明清单，不能无损推断成 Agent、Tool 或 Condition 图。
- 已绑定 n8n 的旧工作流第一阶段以“外部 n8n 工作流”兼容节点保留；新图经过 Adapter 编译并生成稳定的节点映射。
- Studio 应以新路由和功能开关灰度上线，旧创建端、调用接口和已发布工作流在达到功能等价前保持可回滚。
- 运行态必须改为服务端真实事件驱动；当前前端按日志数组延时播放只能作为兼容展示。

## 1. Current Architecture

**优先级：必须做｜难度：Low**

### 1.1 技术栈

| 层 | 当前实现 | 代码位置 |
| --- | --- | --- |
| 页面框架 | Vinext 1.0 beta、React 19、TypeScript 5.9 | `app/`、`vite.config.ts` |
| UI | Tailwind CSS 4、shadcn/Base UI、自定义 CSS | `components/ui/`、`app/globals.css` |
| 主界面 | 一个 1883 行 Client Component，含入口、创建端、使用端、Agent 对话和运行记录 | `components/workflow-lab.tsx` |
| 持久化 | Cloudflare D1 / 本地 SQLite，Drizzle 定义类型，业务查询主要使用 D1 原生 SQL | `db/`、`lib/server/workflow-store.ts` |
| 执行 | 未绑定 Webhook 时模拟；绑定后通过 HTTP 调 n8n；无 n8n 时也可直接调用 OpenAI-compatible Chat API | `lib/server/n8n.ts`、`lib/server/llm.ts` |
| 协议 | `urtoris.v1` 请求/响应信封，含 `requestId`、`sessionId`、`mode`、`degraded` | `lib/server/protocol.ts` |
| 部署 | ECS 上 Wrangler 本地 Worker 监听 `127.0.0.1:3000`；n8n 监听 `127.0.0.1:5678`；Nginx 反代 | `deploy/`、`deploy/n8n/` |

### 1.2 当前用户流

```text
首页身份入口
├─ 创建端
│  └─ 编辑 WorkflowStep[] → 保存草稿 → 发布版本 → 可选绑定 n8nWebhookUrl
└─ 使用端
   ├─ 选择已发布工作流 → POST /api/runs
   └─ Agent 对话 → POST /api/agent/chat
                           ↓
                  模拟器 / 模型 / n8n
                           ↓
                    runs + n8n_events
```

### 1.3 当前工作流模型

`WorkflowRecord` 保存元数据、`draftSteps`、`publishedSteps`、版本号和一个 n8n Webhook URL。步骤只有：

```text
input → transform → decision → compose → output
```

每个 `WorkflowStep` 只有 `id/title/detail/kind`。顺序由数组下标表达，没有 Node、Edge、Port、坐标、分支条件、资源连接或节点配置。

重要事实：站点中的步骤数组与 ECS 上的 n8n `nodes/connections` 没有一一映射。它目前既不是 n8n 工作流的导入结果，也不是 n8n 工作流的编译源，只是发布清单和运行 UI 的展示依据。

### 1.4 当前 API

| 接口 | 用途 | 当前边界 |
| --- | --- | --- |
| `GET /api/state` | 返回工作流与最近运行的公开 DTO | 无鉴权、`no-store`，运行细节已脱敏 |
| `POST /api/workflows` | 新建、保存、发布线性工作流 | 管理令牌、30 次/分钟、64 KB |
| `GET/POST /api/runs` | 查询或触发运行 | 同源浏览器或 API 令牌；读 60、写 20 次/分钟 |
| `POST /api/agent/chat` | 对话并执行已发布工作流 | 同源浏览器或 API 令牌；12 次/分钟 |
| `POST /api/v1/run` | 外部程序调用 | Bearer API 令牌；30 次/分钟；CORS 开放 |
| `GET/POST /api/n8n/events` | n8n 写入/读取节点事件 | 独立内部令牌；单次最多 50 条事件 |

### 1.5 当前运行与追踪

- 网站生成 `requestId/sessionId`，重试保持同一个幂等键。
- `run_claims` 在触发前抢占执行权，`runs.request_id` 唯一索引负责结果去重。
- n8n 在危险节点前上报 `requestId ↔ executionId` 到 `n8n_execution_map`。
- 失败优先按 `executionId` 精确关联，旧工作流才回退到同工作流的 ±2 分钟窗口。
- `engine` 表示承载引擎，`mode` 表示实际业务能力，`degraded` 标识成功但降级。
- 前端并未消费 `n8n_events`。接口返回整条 run 后，页面通过 `setTimeout` 逐条播放日志，节点耗时也不是 n8n 的真实节点耗时。

### 1.6 当前 n8n 资产

仓库包含 W1–W5、Gateway、Common Envelope、Common Log 的补丁与校验脚本，但不包含生产工作流的完整导出 JSON。已知顶层工作流为：

- W1 `urtoris-wf-llm-smoke`
- W2 `urtoris-wf-user-manager`
- W3 `urtoris-wf-security-analysis`
- W4 `urtoris-wf-api-gateway`
- W5 `urtoris-wf-customer-insights`
- `urtoris-gateway`
- `urtoris-common-envelope`
- `urtoris-common-log`

因此 Adapter 的真实验证必须在去凭据的 n8n 导出副本上进行，不能只依据补丁脚本猜测全部节点参数。

## 2. Problems

**优先级：必须做｜难度：Medium**

1. **模型表达力不足。** 数组顺序无法表达多端口、条件分支、并行、Agent 资源、子工作流和可复用节点。
2. **展示模型与运行模型分裂。** 页面展示 `WorkflowStep[]`，n8n 运行另一张不可见的图；用户看到的路线不一定是实际路线。
3. **没有 Adapter 边界。** 当前只有 Webhook URL 绑定，没有 Graph → n8n 编译、版本映射或兼容能力声明。
4. **运行态是事后动画。** 页面在请求结束后播放静态日志，无法真实呈现 waiting/running/error，也无法准确显示节点输入、输出和耗时。
5. **发布版本不可审计。** `published_steps_json` 会被新版本覆盖，没有不可变的版本表、图哈希或 Adapter 产物版本。
6. **组件过度集中。** 数据加载、鉴权令牌、本地 Key、编辑、运行、聊天、WebMCP 和全部界面集中在一个 Client Component，画布加入后会进一步恶化重渲染和测试成本。
7. **节点配置没有类型边界。** 当前只有短文本说明，无法对 HTTP 目标、Robot 指令、数据库查询和模型设置做结构化校验。
8. **导入不能无损。** 仓库没有生产 n8n 图；任意 n8n 节点、表达式、凭据、paired item、AI cluster connection 也不可能全部自动映射成自定义节点。
9. **测试基座偏运维。** 当前有构建、canary 和生产检查器，但没有 Graph 校验、Adapter golden fixture、API contract 或前端交互测试。
10. **D1 模型存在隐式表。** `run_claims` 通过迁移和原生 SQL使用，但未进入 `db/schema.ts`，未来 Graph 表也必须避免这种定义分裂。

## 3. Target Architecture

**优先级：必须做｜难度：High**

```text
Workflow Studio UI
  ├─ Canvas projection（React Flow nodes/edges）
  ├─ Inspector form state
  └─ Runtime overlay
             ↓
       Workflow Service API
             ↓
  Internal WorkflowGraph v1  ← 唯一设计事实源
       │              │
       │              └─ immutable workflow_versions
       ↓
  Validator + Node Registry
       ↓
  Workflow Adapter
       ├─ compile: Graph → n8n Workflow JSON
       └─ import: adapter-owned n8n JSON → Graph
             ↓
       n8n Runtime / Webhook
             ↓
  normalized execution events
             ↓
  runs + run_node_states + n8n_events
```

边界规则：

- UI 只读写 Internal Graph，不出现 n8n 节点类型名、连接数组或表达式语法。
- Node Registry 是节点端口、配置校验、Inspector 与 Adapter handler 的统一注册入口。
- Adapter 输出是可重建产物，不是用户数据的事实源。
- 发布版本不可变；草稿靠 `revision` 做乐观并发控制。
- 执行事件统一使用内部 nodeId；n8n nodeId 通过每个发布版本的编译映射转换。

## 4. Workflow Graph Schema

**优先级：必须做｜难度：High**

完整字段定义见 [WORKFLOW_SCHEMA.md](WORKFLOW_SCHEMA.md)。核心对象为：

```text
WorkflowGraphV1
├─ nodes: WorkflowNode[]
├─ edges: WorkflowEdge[]
├─ entryNodeIds: string[]
├─ runtime: RuntimeTarget
├─ viewport: Viewport
└─ metadata: GraphMetadata
```

连接分为 `main/model/memory/tool/branch/subworkflow`。执行流与资源关系必须区分：`main/branch` 决定调度顺序，`model/memory/tool/subworkflow` 只描述能力挂载，不直接推进主执行流。

运行状态不写回 Graph；它属于 `WorkflowExecution/NodeExecutionState/ExecutionEvent`。否则一次运行会污染已发布版本，也无法支持并发运行。

## 5. Node System

**优先级：必须做｜难度：Medium**

第一版节点注册表至少覆盖：

| 类型 | 角色 | 主要端口 |
| --- | --- | --- |
| Trigger | 工作流入口 | `main.out` |
| AI Agent | 调用模型并选择 Tool | `main.in/out`、`model`、`memory`、`tools[]` |
| LLM Model | 模型资源 | `model.provider` |
| Memory | 会话记忆资源 | `memory.provider` |
| Tool | Agent 可调用能力 | `tool.provider` |
| Condition | 条件分支 | `main.in`、`true`、`false` |
| HTTP Request | 主流程 HTTP 动作 | `main.in/out` |
| Database | 主流程数据库动作 | `main.in/out` |
| Transform | 数据转换 | `main.in/out` |
| Robot Action | 机器人指令 | `main.in/out` |
| Subworkflow | 调用另一发布版本 | `main.in/out` 或 `subworkflow.provider` |
| Output | 工作流终点 | `main.in` |

此外需要一个只用于迁移的 `legacyStep` 或 `externalN8nWorkflow` 节点，避免把旧说明步骤错误猜成真实逻辑。它不出现在新建节点面板中。

每种节点由注册表提供：稳定 type、默认配置、端口工厂、配置校验器、权限级别、Inspector 组件、n8n 编译器、可选导入器和展示组件。前端与 Adapter 都不得维护第二份散落的类型分支。

## 6. AI Agent Architecture

**优先级：必须做｜难度：High**

AI Agent 是“执行节点 + 资源拥有者”，不是一个普通矩形：

```text
main.in → AI Agent → main.out
              ├─ model（恰好 1）→ LLM Model
              ├─ memory（0 或 1）→ Memory
              ├─ tools（0..n）→ Tool / HTTP / Database / Robot
              └─ subworkflows（0..n）→ Subworkflow
```

关键约束：

- Model 必须恰好一个才能发布；草稿阶段允许缺失并显示阻断错误。
- Memory 最多一个；按 `sessionId` 分区，禁止把 API Key 或 Authorization 写入记忆。
- Tool 支持一对多，每个 Tool 必须有唯一名称、说明和输入 JSON Schema。
- Robot Tool 默认要求命令白名单、参数范围、超时、幂等键和可选人工确认，不能让模型直接拼接任意底层指令。
- Agent 配置只保存 `credentialRef`，BYO Key 继续按当次请求透传，不进入图、数据库、Adapter 产物或日志。
- Tool Calling 的每次调用要产生 node-level event，并继承同一 `requestId/executionId/sessionId`。

## 7. Canvas UI Architecture

**优先级：推荐做｜难度：Medium**

建议使用 `@xyflow/react`（React Flow）作为交互层，而不是自研拖拽/连线。当前项目没有同类依赖；React Flow 已提供自定义节点、多 Handle、曲线 Edge、缩放、选择和保存/恢复基础，能覆盖本计划的核心需求。官方资料：[Custom Nodes](https://reactflow.dev/learn/customization/custom-nodes)、[Handles](https://reactflow.dev/learn/customization/handles)、[Save and Restore](https://reactflow.dev/examples/interaction/save-and-restore)。

但 React Flow 对象不能直接成为后端 Schema。需要两层转换：

```text
WorkflowGraph ↔ CanvasProjection ↔ ReactFlow Node/Edge
```

布局采用顶部命令栏、左侧节点库、中间无限画布、右侧 Inspector、底部运行面板。详细交互和响应式方案见 [WORKFLOW_UI_DESIGN.md](WORKFLOW_UI_DESIGN.md)。

## 8. Runtime / Execution Architecture

**优先级：必须做｜难度：High**

运行流程应从“同步等待完整结果”改为“创建运行 + 订阅事件”：

```text
POST run → 202 {runId, requestId}
              ↓
GET /runs/:runId/stream（SSE）
              ↓
workflow.started
node.waiting / node.started / node.succeeded / node.failed / node.skipped
workflow.succeeded / workflow.failed
```

状态机统一为：

```text
idle → waiting → running → success
                     ├────→ error
                     └────→ skipped / cancelled（兼容未来）
```

事件必须带单调递增的 `sequence`，支持断线后 `after=<sequence>` 补拉。节点 Input/Output 使用受限大小的快照或引用，不在公共 `/api/state` 中暴露。现有同步 `/api/runs`、`/api/agent/chat` 和 `/api/v1/run` 保持兼容，内部可等待新执行服务终态后返回旧响应形状。

## 9. n8n Adapter Design

**优先级：必须做｜难度：High**

Adapter 分为五步：验证 Graph、规范化、编译节点、编译连接、注入协议与观测包装。每次编译产生：

```text
CompiledWorkflow
├─ n8nWorkflowJson
├─ internalNodeId ↔ n8nNodeId/name map
├─ warnings / unsupported capabilities
├─ graphHash
└─ adapterVersion
```

映射原则：

- `main` 连接映射到 n8n `main` 输出。
- Condition 的 `true/false` 映射到 IF/Switch 的稳定输出索引。
- Agent 的 Model/Memory/Tool 关系映射到 n8n 对应 AI connection type；资源边在内部图中的方向是“拥有者 → 提供者”，编译时可按 n8n 连接方向反转。
- Subworkflow 映射为 Execute Workflow；引用必须固定到已发布版本或明确采用 `latestPublished` 策略。
- 每个生成节点使用稳定名称和 ID，并在 metadata 中携带内部 nodeId，以便事件反查。
- 编译器必须幂等：同一个 Graph + Adapter 版本得到相同结构和 hash。

双向映射不是对任意 n8n JSON 的承诺。只有 Adapter 自己生成且带映射 metadata 的工作流保证可逆；未知节点导入为只读 opaque 节点并保留原始扩展，不能静默丢字段。

生产 n8n Public API 当前被禁用，所以第一版 Adapter 只生成/校验部署产物，部署继续走受控 CLI/运维流程。不要为了 Studio 直接重新开放公网 n8n API。

## 10. Frontend Component Architecture

**优先级：推荐做｜难度：Medium**

建议拆分为：

```text
WorkflowStudioPage
├─ StudioToolbar
├─ NodePalette
├─ WorkflowCanvas
│  ├─ CanvasNodeRenderer
│  └─ CanvasEdgeRenderer
├─ NodeInspector
│  ├─ ConfigForm
│  └─ ValidationPanel
├─ ExecutionPanel
│  ├─ Timeline
│  ├─ InputOutputInspector
│  └─ ErrorInspector
└─ PublishDialog
```

再按领域拆 hooks/store：`useWorkflowGraph`、`useSelection`、`useDraftPersistence`、`useExecutionStream`。选择态、Viewport 和临时拖拽态不应写入 React 组件大对象；节点渲染器、nodeTypes、edgeTypes 和回调需稳定引用。React Flow 官方也明确建议 memoize 节点/边组件并避免订阅整个 nodes 数组：[Performance](https://reactflow.dev/learn/advanced-use/performance)。

现有 `WorkflowLab` 在灰度期继续承载身份入口和旧界面；Studio 先作为独立路由/组件上线，不直接在 1883 行文件内继续堆叠。

## 11. Backend API Changes

**优先级：必须做｜难度：High**

新增版本化接口，旧接口保持：

| 新接口 | 作用 | 权限 |
| --- | --- | --- |
| `GET /api/workflows/:id/graph` | 读取草稿图与 revision | 管理员 |
| `PUT /api/workflows/:id/graph` | 校验并保存草稿，要求 `If-Match`/revision | 管理员 |
| `POST /api/workflows/:id/validate` | 返回结构和发布阻断项 | 管理员 |
| `POST /api/workflows/:id/publish` | 创建不可变版本并编译 Adapter 产物 | 管理员 |
| `GET /api/workflows/:id/versions` | 版本历史 | 管理员 |
| `POST /api/workflows/:id/runs` | 创建异步运行 | 执行权限 |
| `GET /api/runs/:runId` | 获取完整运行详情 | 执行权限 |
| `GET /api/runs/:runId/events` | 补拉/SSE 订阅节点事件 | 执行权限 |

服务端必须重复执行 Graph 验证、目标 URL 白名单、凭据引用权限和发布前 capability 检查。浏览器给出的节点类型、端口和 Adapter target 都不可信。

## 12. Migration Strategy

**优先级：必须做｜难度：High**

采用 add-only、双读、灰度切换：

1. 增加 Graph 类型、验证器与 Adapter interface，不改变现有 API。
2. 添加图草稿、不可变版本、编译映射与节点运行态表，保留旧 steps 字段。
3. 将旧线性步骤迁为 `legacyStep` 图；绑定 n8n 的工作流用 opaque runtime 节点保持原 Webhook 行为。
4. 新增 `/studio` 并以功能开关仅对管理员开放。
5. 只有可编译的新图才允许切换到 Adapter 运行路径；旧 Webhook 路径继续可用。
6. 运行事件接入后，旧同步接口由兼容层等待终态并返回旧 DTO。
7. 连续两个稳定发布周期后，再评估停写旧 steps；本计划不安排删除旧字段。

完整迁移、验证和回滚步骤见 [MIGRATION_PLAN.md](MIGRATION_PLAN.md)。

## 13. Risks

**优先级：必须做｜难度：Medium**

| 风险 | 后果 | 控制措施 |
| --- | --- | --- |
| 把展示步骤误当真实 n8n 图 | 发布后行为变化 | legacy/opaque 迁移，不做语义猜测 |
| Adapter 无损承诺过大 | 未知节点或表达式丢失 | 只保证 adapter-owned 工作流可逆，未知节点只读 |
| 前端信任端口关系 | 绕过 SSRF/机器人权限 | 服务端 Registry 重新验证并执行策略 |
| 运行事件乱序/重复 | 节点状态倒退或串号 | `runId + sequence + nodeId` 唯一约束，幂等 reducer |
| 画布拖动导致全树重渲染 | 比赛演示卡顿 | 独立 store、稳定回调、memo、简化 active edge 效果 |
| n8n 版本差异 | 编译 JSON 不兼容 | Adapter 版本锁、fixture、克隆环境 canary |
| D1 写放大 | 事件过多、空间增长 | 状态快照 + 有界事件、payload 引用、pruning |
| 旧 API 与新 Graph 分叉 | 两套事实源 | Graph 为主，旧 steps 仅由兼容投影生成 |
| 子工作流循环 | 无限递归 | 发布时依赖图检测、最大深度和超时 |
| Robot Tool 误动作 | 设备或现场风险 | 命令白名单、参数范围、幂等、急停/确认策略 |

## 14. Implementation Phases

**优先级：必须做｜难度：Medium**

| 阶段 | 交付 | 进入条件 |
| --- | --- | --- |
| 0. 设计 | 本次四份文档 | 人工评审通过 |
| 1. Domain | Graph 类型、Registry、Validator、测试 fixture | 无源码行为变化 |
| 2. Persistence | 新表/列、版本服务、legacy 投影 | 迁移备份与回滚演练通过 |
| 3. Adapter | Graph → n8n 编译、opaque import、golden tests | 克隆 n8n 通过 W1/W4 canary |
| 4. Studio MVP | 拖拽、连线、端口、Condition、保存、发布 | 功能开关开启给管理员 |
| 5. Runtime UI | SSE、真实节点状态、Inspector | 事件顺序/重连/并发测试通过 |
| 6. 灰度 | 旧/新路径并行、迁移单个低风险工作流 | 生产备份和回滚开关就绪 |
| 7. 比赛能力 | Tool Calling、Robot/ESP32、演示剧本 | 安全策略和现场压测通过 |

第一版验收只覆盖：节点拖拽、连线、Agent 的 Model/Memory/多 Tool、Condition 分支、保存、运行和真实节点状态。动画、自动布局、MiniMap、右键菜单、Command Palette 与协作编辑延后。

## 15. Files That Would Eventually Need Modification

**优先级：必须做｜难度：Low**

以下是评审通过后“可能需要”的文件清单，不代表本阶段已修改：

### 新增

```text
app/studio/page.tsx
app/api/workflows/[id]/graph/route.ts
app/api/workflows/[id]/validate/route.ts
app/api/workflows/[id]/publish/route.ts
app/api/workflows/[id]/runs/route.ts
app/api/runs/[runId]/route.ts
app/api/runs/[runId]/events/route.ts
components/studio/workflow-studio.tsx
components/studio/workflow-canvas.tsx
components/studio/node-palette.tsx
components/studio/node-inspector.tsx
components/studio/execution-panel.tsx
components/studio/nodes/*.tsx
lib/workflow-graph/types.ts
lib/workflow-graph/registry.ts
lib/workflow-graph/validate.ts
lib/workflow-graph/project-canvas.ts
lib/server/workflow-graph-store.ts
lib/server/execution-events.ts
lib/server/adapters/n8n/*.ts
drizzle/0007_workflow_graph.sql
```

### 修改

```text
package.json                         # 评审后再加入 @xyflow/react
app/globals.css                      # Studio token 与画布样式
components/workflow-lab.tsx          # 只增加入口/兼容跳转，逐步瘦身
db/schema.ts                         # 新版本、映射、运行态表
lib/workflow-types.ts                # 兼容 DTO，最终引用 Graph 类型
lib/server/workflow-store.ts         # 旧 API 投影与双读
lib/server/n8n.ts                    # 调 Adapter 产物与事件关联
app/api/workflows/route.ts           # 保持旧协议并接兼容服务
app/api/runs/route.ts                # 接入异步执行兼容层
app/api/agent/chat/route.ts           # 接入 Graph 发布版本
app/api/v1/run/route.ts              # 保持外部契约
docs/PROTOCOL-v1.md                  # 增加节点事件协议但不破坏 v1 信封
docs/OPERATIONS.md                   # Studio 发布、Adapter 与回滚运维
```

### 不应直接修改

- 生产 n8n 数据库和工作流：先导出、去凭据、在克隆环境验证。
- 当前 W1–W5 的生产版本：在 Adapter 等价 canary 通过前继续作为执行基线。
- 现有 `urtoris.v1` 外部响应形状：新增能力通过兼容字段或新版本承载。

## 第一阶段验收结论

- 已明确当前架构、问题和目标边界。
- 已给出具体 Internal Graph Schema、节点系统、Runtime Event、n8n Adapter 和分阶段迁移设计。
- 已明确旧 `WorkflowStep[]` 不能无损还原真实 n8n 图。
- 本阶段没有实施 UI、数据库、API 或 n8n 代码变更；下一步必须先人工评审四份文档。
