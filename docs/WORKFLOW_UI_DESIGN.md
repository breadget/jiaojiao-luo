# Workflow Studio UI 设计

> 状态：首个 MVP 已在 `/studio` 实现。画布、节点库、桌面/紧凑 Inspector、校验、草稿保存和兼容运行已可用；Deploy 在 Adapter 接入前明确锁定，兼容运行只显示真实 run envelope。真实节点事件流、Graph 编译发布和性能基线待完成。
>
> 优先级：推荐做｜难度：Medium

## 1. 产品目标

Workflow Studio 不是 n8n 换皮，也不是只会拖卡片的流程图。第一版必须让用户完成一条真实闭环：

```text
创建 Graph → 校验 → 保存 → 发布 → 由 n8n 运行 → 实时查看节点状态与结果
```

三个优先级：

1. 运行语义和现有接口兼容。
2. Agent、Model、Memory、Tool 与 Condition 的结构一眼可读。
3. 视觉质感服务于比赛演示，但不先于运行闭环。

## 2. Canvas 选型

### 结论

采用 `@xyflow/react`（React Flow）作为画布交互层，评审通过后再加入依赖。

### 原因

- 当前仓库没有节点画布库，自研拖拽、缩放、连线、选择框和触摸交互成本过高。
- React Flow 支持自定义节点与任意数量 Handle，适合 Agent 的 Model/Memory/多 Tool 端口：[Custom Nodes](https://reactflow.dev/learn/customization/custom-nodes)、[Handles](https://reactflow.dev/learn/customization/handles)。
- Edge 原生支持曲线并可通过 sourceHandle/targetHandle 精确连接端口。
- 官方提供保存/恢复、连接校验、子图、触摸和 cycle detection 示例，足够支撑 MVP：[Examples](https://reactflow.dev/examples)、[Save and Restore](https://reactflow.dev/examples/interaction/save-and-restore)。
- 它只在 Client Component 内运行，与现有 Vinext/React 结构没有根本冲突。

### 边界

React Flow 的 Node/Edge 不是后端协议。`selected/dragging/measured/width/height` 等 UI 字段不能直接入库。必须通过 `CanvasProjection` 在 Internal Graph 和 React Flow 之间转换。

```text
Internal Graph
   ↕ projectToCanvas / projectFromCanvas
React Flow controlled state
```

## 3. 信息架构

桌面布局：

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Urtoris / Workflow name     Draft saved   Validate  Run  Publish    │
├──────────────┬───────────────────────────────────┬───────────────────┤
│ Node Library │                                   │ Inspector         │
│              │              Canvas               │                   │
│ Trigger      │                                   │ Config            │
│ Agent        │      ┌─────────────────┐          │ Ports             │
│ Logic        │ ───▶ │    AI Agent     │ ───▶     │ Validation        │
│ Data         │      └─────────────────┘          │                   │
│ Actions      │          ◇   ◇   ◇                │                   │
│ Resources    │        Model Mem Tools            │                   │
├──────────────┴───────────────────────────────────┴───────────────────┤
│ Execution  Timeline | Input | Output | Log | Error       RUN abc123 │
└──────────────────────────────────────────────────────────────────────┘
```

建议尺寸：

| 区域 | 默认尺寸 | 行为 |
| --- | --- | --- |
| 顶部命令栏 | 56 px | 固定，不随画布滚动 |
| 节点库 | 232 px | 可折叠；支持分类和搜索 |
| Inspector | 360 px | 可折叠；跟随单选节点/边 |
| Execution Panel | 248 px | 可调整高度，运行时自动展开 |
| Canvas | 剩余空间 | 无限平移、缩放 0.2–2.0 |

## 4. 视觉方向

Studio 使用深色工作面，但保留 Urtoris 的海军蓝、纸白和安全橙品牌：

- Canvas：接近黑蓝的中性底色，细点阵或网格。
- 节点：深灰蓝圆角卡片，1 px 边线；默认不使用重阴影。
- 主执行连接：中性亮线；运行时用绿色或橙色增强。
- 资源连接：Model 紫、Memory 蓝、Tool 青；颜色之外同时用标签和端口形状区分。
- Condition：true 绿色、false 暖红；边上固定显示文字。
- 错误：红色外框 + 图标 + 文本，不能只靠颜色。
- 选中：2 px 安全橙焦点环；键盘焦点与鼠标选中可同时理解。

节点视觉建议：

```text
┌────────────────────────────┐
│ 🤖  AI Agent        RUNNING│
│ Tools Agent                │
│ 3 tools · Qwen · Memory    │
└────────────────────────────┘
    ◇ Model   ◇ Memory   ◇ Tools
```

节点最小宽度 220 px；Agent 260–300 px；连接 Handle 的可点击区域至少 16 px，视觉点可更小。

## 5. Node Library

分类与第一版内容：

```text
Trigger
  Webhook Trigger

Agent
  AI Agent
  LLM Model
  Memory

Logic
  Condition
  Transform

Data
  HTTP Request
  Database

Actions
  Robot Action
  Output

Resources
  Tool
  Subworkflow
```

交互：

- 拖入画布时创建 Registry 默认配置和稳定 UUID。
- 单击节点模板时放到当前 viewport 中心，作为触控和键盘替代方式。
- 搜索匹配名称、类型、能力和别名。
- 发布环境不显示 `legacyStep/externalN8nWorkflow` 新建入口；它们只在迁移图里出现。
- 高风险节点显示盾牌标记，拖入后立即提示需要的策略或凭据引用。

## 6. Canvas 交互

### MVP 必须支持

- 拖入节点、移动、单选、多选、删除。
- 空白处平移，滚轮/触控板缩放，Fit View。
- 从端口拖线；连接时只高亮合法目标。
- Condition true/false 固定独立 Handle。
- Agent Tool Handle 允许多条连接，Model/Memory 到达上限后不可再连。
- 保存 viewport，但 viewport 变化不标记业务配置发生变化。
- 保存前即时校验，发布前服务端最终校验。

### 连接反馈

连接前由 `canConnect(source, target, graph)` 检查：

1. 端口 kind 与方向。
2. min/max cardinality。
3. Node type 能力。
4. 是否产生环。
5. 是否跨越禁止的所有权关系。

拒绝连接时在指针旁显示一句具体原因，例如“一个 Agent 只能连接一个 Model”，而不是仅让线消失。

### 暂缓

自动布局、MiniMap、右键菜单、Command Palette、复制粘贴、Undo/Redo、多人协作和复合分组不进入首版。数据模型需要允许未来加入，但不以它们阻塞运行闭环。

## 7. Node Inspector

Inspector 不直接操作 React Flow `node.data`，而是编辑 Internal Graph 中的 node config。结构：

```text
Node Inspector
├─ General：名称、说明、禁用
├─ Configuration：按 Registry 渲染的类型表单
├─ Ports：连接状态、必填项、上限
├─ Policy：凭据引用、目标白名单、风险等级
└─ Validation：与该节点相关的 error/warning
```

输入表单保留本地 draft，失焦或显式 Apply 时提交 graph command，避免每个按键都重建整张画布。删除高风险节点、替换 Agent Model、改变 Subworkflow 版本策略需要确认。

边 Inspector 展示 source/target、kind、label、order 和 branch；第一版不允许用户手工更改 Edge kind，只能重新连接合法端口。

## 8. Runtime UI

### 状态表示

| 状态 | 节点表现 | Edge 表现 |
| --- | --- | --- |
| `idle` | 默认边框 | 默认 |
| `waiting` | 空心时钟/灰白标签 | 进入边弱化 |
| `running` | 橙色外框、spinner、开始时间 | 当前路径轻量流动 |
| `success` | 绿色勾、真实 duration | 已走路径绿色 |
| `error` | 红色外框、错误码 | 失败进入边红色 |
| `skipped` | 降低透明度、明确“跳过” | 未走分支虚线 |

遵循 `prefers-reduced-motion`：关闭粒子/流动动画，改用静态粗线和状态图标。不要给所有 Edge 同时加昂贵滤镜。

实现补充（2026-09-11）：

- Edge 状态由 `lib/workflow-graph/edge-runtime.ts` 从节点遥测推导，判据是**下游有没有
  真的开始执行**，而不是"源节点成功就点亮"——否则 Condition 的 true / false 会一起变绿。
- 两条保守规则：运行未定稿时下游没动静只算 `waiting`；资源连接（model / memory /
  tool / subworkflow）的下游没有事件属于正常，永不画成"未走分支"。
- **没有任何节点级观测时，所有 Edge 保持默认态**：模拟运行、遥测不可用或事件尚未到达
  时，不把"我们没看见"渲染成"这条路没走"。
- 线型也承载语义（未走/未观测 = 虚线），因此状态不依赖颜色单独表达。

### 事件处理

- Run 后立即拿到 `runId/requestId`，所有节点先进入 idle/waiting。
- SSE 事件由幂等 reducer 按 sequence 应用。
- 断线后显示“正在重连”，使用最后 sequence 补拉；不能把节点重置为 idle。
- 工作流终态与最后节点状态分开处理；一个 Tool 失败可能由 Agent 捕获并让工作流成功。
- 选择历史运行时加载该版本的 Graph snapshot，避免用新草稿覆盖旧运行路线。

### Execution Panel

底部面板提供：

- `Timeline`：按 sequence 显示节点与 Tool 事件。
- `Input`：当前节点输入的脱敏快照。
- `Output`：结构化 JSON/文本预览。
- `Log`：该节点的可读日志。
- `Error`：错误码、消息、节点、重试性和 requestId。
- `Metadata`：runId、requestId、executionId、sessionId、duration、engine、mode、degraded。

API Key、Authorization、Cookie、数据库连接串和 Robot 密钥在写入前服务端脱敏；前端不承担最后一道脱敏责任。

## 9. Toolbar 与发布流程

Toolbar 状态：

```text
Workflow name | Draft saved / Unsaved | Errors 2 | Run | Publish
```

### Save

- 发送当前 `revision`；冲突返回 409 并要求重新加载/比较。
- 保存允许不完整草稿，但清楚显示错误数。
- 自动保存可在 MVP 后加入；第一版优先显式保存，减少并发复杂度。

### Validate

- 展开 Validation Panel，按 Workflow/Node/Edge 分类。
- 点击问题自动选中并居中对应节点/边。

### Publish

发布弹窗显示：

- 新版本号、Graph hash、Adapter 版本。
- errors（必须为 0）、warnings 和风险节点清单。
- 与上一发布版本的结构摘要：新增/删除/修改节点与 Edge。
- 编译目标与现有 external Webhook 是否改变。

只有服务端编译和验证成功后才创建不可变版本。

## 10. 前端状态架构

建议分为四类状态：

| Store | 内容 | 是否持久化 |
| --- | --- | --- |
| Graph domain | nodes、edges、metadata、revision | 是 |
| Canvas UI | selection、viewport、dragging、panel size | 仅 viewport 可持久化 |
| Inspector draft | 当前表单输入、dirty、field errors | 否 |
| Runtime | run、nodeStates、events、connection status | 运行记录持久化，UI 临时态不持久化 |

Graph 更新使用命令式 reducer：

```text
addNode / updateNodeConfig / moveNodes / removeNodes
connectPorts / removeEdges / renameWorkflow / setViewport
```

每个命令同时返回受影响节点，便于增量验证和未来 Undo/Redo。React Flow nodeTypes/edgeTypes 在模块作用域声明；自定义节点 `memo`；面板只订阅具体 nodeId/state。官方性能指南同样建议避免节点移动时让依赖完整 nodes 数组的组件全部重渲染：[Performance](https://reactflow.dev/learn/advanced-use/performance)。

## 11. 前端组件边界

```text
app/studio/page.tsx
└─ WorkflowStudio
   ├─ StudioToolbar
   ├─ NodePalette
   ├─ WorkflowCanvas
   │  ├─ nodes/TriggerNode
   │  ├─ nodes/AiAgentNode
   │  ├─ nodes/ResourceNode
   │  ├─ nodes/ConditionNode
   │  └─ edges/RuntimeEdge
   ├─ NodeInspector
   │  └─ inspectors/*
   ├─ ValidationPanel
   ├─ PublishDialog
   └─ ExecutionPanel
```

`WorkflowLab` 不继续承载新画布逻辑。灰度期间它只增加“打开 Studio”入口，旧创建端仍可运行。

## 12. 响应式与无障碍

### 桌面

1280 px 以上显示完整三栏；1024–1279 px 时 Inspector 覆盖/抽屉化，节点库可折叠。

### 平板与手机

- 画布可查看、运行、选节点；编辑入口默认提示建议横屏或桌面。
- 节点库和 Inspector 使用 Sheet；底部 Execution Panel 全屏展开。
- 所有节点模板都支持“点击添加”，不能只支持 drag-and-drop。

### 键盘与屏幕阅读器

- Toolbar、节点库、Inspector 按正常 DOM 顺序导航。
- 节点具有可读名称、类型和状态；状态更新通过适度的 `aria-live` 汇总，而非每个动画逐条播报。
- Delete/Backspace 删除前考虑焦点和表单输入上下文。
- 端口连接需要可替代的“选择源端口 → 选择目标端口”键盘模式。
- 色彩对比满足 WCAG AA；状态永远有文字/图标双重表达。

## 13. MVP 验收

1. 可创建 Trigger → Agent → Condition → 两个 Output 的图。
2. Agent 可连 1 个 Model、0/1 个 Memory 和至少 3 个 Tool。
3. 非法连接即时提示，服务端再次拒绝非法 Graph。
4. 保存后刷新可恢复 Graph 与 viewport，发布生成不可变版本。
5. Run 后节点状态来自真实事件，不是前端模拟 sleep。
6. 点节点可查看 Input、Output、Log、Error、Duration 与 requestId。
7. 同 requestId 并发不重复执行，两个不同 requestId 不串节点事件。
8. `mode=rules/degraded=true` 与 `mode=llm/degraded=false` 在节点和运行层都可读。
9. 旧工作流和 `/api/v1/run` 未回归，可一键关闭 Studio 功能开关。
10. 100 个节点/200 条边的拖动、缩放和状态更新无明显卡顿。

## 14. 明确不做

- 不复制 n8n 全部节点和配置面板。
- 不把任意 JavaScript、SQL 或 URL 暴露给非受控用户。
- 不在浏览器里部署 n8n Workflow。
- 不在首版实现实时多人协作、Marketplace 或可视化调试器。
- 不因暗色画布重做现有身份入口和使用端全部视觉。
