# Internal Workflow Graph Schema v1

> 状态：Graph V1 类型、Registry、legacy projector、validator 与草稿 API 已实现；发布快照、Adapter 和运行事件模型待实现。
>
> 优先级：必须做｜难度：High

## 1. 设计原则

1. `WorkflowGraphV1` 是设计事实源；React Flow 与 n8n JSON 都是投影或编译产物。
2. 图结构、节点配置与运行状态分离。发布版本不可被运行过程修改。
3. 节点 ID 和端口 ID 在一个工作流生命周期内稳定，改标题或位置不改 ID。
4. 所有入库 Graph 都必须经过服务端验证，前端校验只用于即时反馈。
5. Graph 中只能保存凭据引用，禁止保存 API Key、Authorization、Cookie 或私钥。
6. 未知字段通过 `extensions` 隔离；核心执行不得依赖任意扩展字段。
7. v1 主执行图默认为 DAG。循环、动态端口和任意代码节点留到后续 schemaVersion。

## 2. 顶层结构

建议 TypeScript 契约：

```ts
export type GraphSchemaVersion = 1;

export type WorkflowGraphV1 = {
  schemaVersion: GraphSchemaVersion;
  id: string;
  name: string;
  description: string;
  revision: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  entryNodeIds: string[];
  runtime: RuntimeTarget;
  viewport?: CanvasViewport;
  metadata: GraphMetadata;
  extensions?: Record<string, unknown>;
};

export type RuntimeTarget = {
  engine: 'n8n';
  adapter: 'n8n-v1';
  adapterVersion: string;
  timeoutMs: number;
  executionMode: 'webhook';
  binding?:
    | { kind: 'compiled'; externalWorkflowId?: string }
    | { kind: 'external'; webhookPath: string; externalWorkflowId?: string };
};

export type CanvasViewport = {
  x: number;
  y: number;
  zoom: number;
};

export type GraphMetadata = {
  createdAt: number;
  updatedAt: number;
  createdBy?: string;
  updatedBy?: string;
  tags?: string[];
  source: 'urtoris' | 'legacy-steps' | 'n8n-import';
  legacyWorkflowId?: string;
};
```

### 字段约束

| 字段 | 规则 |
| --- | --- |
| `schemaVersion` | v1 固定为数字 `1` |
| `id` | `wf_` 开头或兼容现有工作流 ID；1–80 字符 |
| `name` | trim 后 2–80 字符 |
| `description` | 0–500 字符 |
| `revision` | 每次保存草稿递增，用于乐观锁，不等于发布版本号 |
| `nodes` | ID 唯一；v1 建议 1–100 个 |
| `edges` | ID 唯一；端点必须存在；v1 建议 0–300 条 |
| `entryNodeIds` | 必须指向 Trigger；第一版恰好 1 个 |
| `runtime.timeoutMs` | 1000–120000，默认 45000 |
| `viewport.zoom` | 0.1–4；它只影响打开位置，不影响执行 |

## 3. Node、Port 与 Edge

```ts
export type NodeType =
  | 'trigger'
  | 'aiAgent'
  | 'llmModel'
  | 'memory'
  | 'tool'
  | 'condition'
  | 'httpRequest'
  | 'database'
  | 'transform'
  | 'robotAction'
  | 'subworkflow'
  | 'output'
  | 'legacyStep'
  | 'externalN8nWorkflow';

export type ConnectionKind =
  | 'main'
  | 'model'
  | 'memory'
  | 'tool'
  | 'branch'
  | 'subworkflow';

export type PortDirection = 'input' | 'output';

export type WorkflowNode<TConfig = Record<string, unknown>> = {
  id: string;
  type: NodeType;
  name: string;
  description?: string;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  ports: WorkflowPort[];
  config: TConfig;
  disabled?: boolean;
  notes?: string;
  extensions?: {
    n8n?: Record<string, unknown>;
    [namespace: string]: unknown;
  };
};

export type WorkflowPort = {
  id: string;
  label: string;
  kind: ConnectionKind;
  direction: PortDirection;
  dataType: string;
  required: boolean;
  minConnections: number;
  maxConnections: number | null;
};

export type WorkflowEdge = {
  id: string;
  kind: ConnectionKind;
  source: EdgeEndpoint;
  target: EdgeEndpoint;
  label?: string;
  order?: number;
  condition?: BranchCondition;
  disabled?: boolean;
  extensions?: Record<string, unknown>;
};

export type EdgeEndpoint = {
  nodeId: string;
  portId: string;
};

export type BranchCondition = {
  branch: 'true' | 'false' | string;
};
```

### 连接方向

- `main` 与 `branch`：`source → target` 是真实调度方向。
- `model/memory/tool/subworkflow`：`source → target` 是“拥有者 → 提供者”的挂载关系，不代表先后执行；UI 默认不画箭头。
- n8n 对 AI 资源连接的存储方向若与内部方向相反，由 Adapter 转换，不能改变 Internal Graph 语义。

### 通用端口规则

1. Edge 的 `kind` 必须同时等于源端口与目标端口的 `kind`。
2. 源端口必须为 `output`，目标端口必须为 `input`。
3. `maxConnections=null` 表示不限；发布时必须满足端口的 min/max。
4. 一个 Edge 不得自连；同一对端点不允许重复 Edge。
5. `main/branch` 子图不得成环；资源关系也不得形成所有权循环。
6. disabled 节点或边不参与编译，但发布校验要报告因此产生的断路。

## 4. Node Registry

端口与默认配置由注册表生成，持久化的 `ports` 是版本快照，用于发布可复现；保存时服务端会用注册表校验快照。

```ts
export type NodeDefinition<TConfig> = {
  type: NodeType;
  version: number;
  category: 'trigger' | 'agent' | 'logic' | 'data' | 'action' | 'resource';
  label: string;
  createDefaultConfig(): TConfig;
  createPorts(config: TConfig): WorkflowPort[];
  validate(config: TConfig, context: ValidationContext): GraphIssue[];
  capability: string;
  risk: 'low' | 'medium' | 'high';
  adapter: 'supported' | 'opaque' | 'unsupported';
};
```

Node Registry 是以下四处的共同来源：节点库、Inspector 表单、服务端验证、n8n Adapter。禁止在四处分别写 `switch(node.type)` 并逐渐产生差异。

## 5. 标准节点与端口

| NodeType | 端口 | 连接数 |
| --- | --- | --- |
| `trigger` | `main.out` | 输出 1..n；无输入 |
| `aiAgent` | `main.in`、`main.out`、`resource.model`、`resource.memory`、`resource.tools`、`resource.subworkflows` | model=1；memory=0..1；tools/subworkflows=0..n |
| `llmModel` | `model.provider` | 目标 0..1 |
| `memory` | `memory.provider` | 目标 0..1 |
| `tool` | `tool.provider` | 目标 0..1；同一 Tool 第一版不共享给多个 Agent |
| `condition` | `main.in`、`branch.true`、`branch.false` | 输入 1；两个分支发布时各 1..n |
| `httpRequest` | `main.in`、`main.out` | 输入 1，输出 0..n |
| `database` | `main.in`、`main.out` | 输入 1，输出 0..n |
| `transform` | `main.in`、`main.out` | 输入 1，输出 0..n |
| `robotAction` | `main.in`、`main.out` | 输入 1，输出 0..n |
| `subworkflow` | `main.in/out` 或 `subworkflow.provider` | 两种模式互斥 |
| `output` | `main.in` | 输入 1..n；无输出 |
| `legacyStep` | `main.in/out` | 仅兼容迁移，不允许新建 |
| `externalN8nWorkflow` | `main.in/out` | 将现有 Webhook 包成一个不可展开执行节点 |

## 6. 节点配置

### Trigger

```ts
type TriggerConfig = {
  trigger: 'webhook' | 'manual';
  inputSchema: JsonSchema;
  authPolicy: 'urtoris-token' | 'internal';
};
```

第一版只编译 `webhook/manual`。Webhook 路径由服务端生成，不允许用户填完整目标 URL。

### AI Agent

```ts
type AiAgentConfig = {
  strategy: 'tools';
  instructions: string;
  maxIterations: number;
  timeoutMs: number;
  outputSchema?: JsonSchema;
  fallbackPolicy: 'error' | 'rules';
  rulesProfile?: string;
};
```

`maxIterations` 建议 1–12；`fallbackPolicy=rules` 时必须能在响应中明确写 `mode=rules, degraded=true`。

### LLM Model

```ts
type LlmModelConfig = {
  provider: 'openai-compatible';
  model: string;
  baseUrlRef: string;
  credentialRef?: string;
  allowBringYourOwnKey: boolean;
  temperature?: number;
  maxTokens?: number;
};
```

`baseUrlRef` 指向服务端登记的 endpoint profile，不接受任意运行时 URL。BYO Key 不写入 `credentialRef`，只随执行请求进入内存。

### Memory

```ts
type MemoryConfig = {
  provider: 'window' | 'postgres';
  namespaceTemplate: '{{sessionId}}';
  maxTurns: number;
  ttlSeconds?: number;
};
```

### Tool

```ts
type ToolConfig = {
  name: string;
  description: string;
  implementation:
    | 'http'
    | 'database'
    | 'robot'
    | 'search'
    | 'subworkflow';
  inputSchema: JsonSchema;
  timeoutMs: number;
  policyRef: string;
  idempotency: 'required' | 'optional' | 'none';
  confirmation: 'never' | 'on-risk' | 'always';
  targetRef: string;
};
```

Tool 的 `targetRef/policyRef` 必须解析为服务端白名单。Graph 不保存连接密码、Robot 密钥或数据库 DSN。

### Condition

```ts
type ConditionConfig = {
  expression: {
    left: ValueExpression;
    operator:
      | 'eq'
      | 'neq'
      | 'gt'
      | 'gte'
      | 'lt'
      | 'lte'
      | 'contains'
      | 'matches';
    right: ValueExpression;
  };
  onEvaluationError: 'fail' | 'false';
};

type ValueExpression =
  | { kind: 'literal'; value: unknown }
  | { kind: 'path'; value: string };
```

第一版不允许任意 JavaScript 表达式；路径语法由 Urtoris 定义并由 Adapter 转译。

### HTTP / Database / Robot / Transform

```ts
type HttpRequestConfig = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  endpointRef: string;
  path: string;
  headers: Record<string, TemplateValue>;
  body?: TemplateValue;
  timeoutMs: number;
};

type DatabaseConfig = {
  connectionRef: string;
  operation: 'select' | 'insert' | 'update';
  statementRef: string;
  parameters: Record<string, TemplateValue>;
};

type RobotActionConfig = {
  robotRef: string;
  command: string;
  parameters: Record<string, TemplateValue>;
  timeoutMs: number;
  requireAck: boolean;
};

type TransformConfig = {
  operation: 'pick' | 'map' | 'template' | 'set';
  mapping: Record<string, TemplateValue>;
};
```

### Subworkflow

```ts
type SubworkflowConfig = {
  workflowId: string;
  versionPolicy: 'pinned' | 'latestPublished';
  version?: number;
  mode: 'main' | 'tool';
  inputMapping: Record<string, TemplateValue>;
  outputMapping?: Record<string, TemplateValue>;
  maxDepth: number;
};
```

发布时建立工作流依赖图并拒绝循环引用。

## 7. 完整示例

```json
{
  "schemaVersion": 1,
  "id": "wf_robot_triage",
  "name": "比赛现场分流与机器人动作",
  "description": "Agent 判断请求并选择机器人动作。",
  "revision": 7,
  "entryNodeIds": ["node_trigger"],
  "runtime": {
    "engine": "n8n",
    "adapter": "n8n-v1",
    "adapterVersion": "1.1.0",
    "timeoutMs": 45000,
    "executionMode": "webhook",
    "binding": { "kind": "compiled" }
  },
  "viewport": { "x": 24, "y": 80, "zoom": 0.9 },
  "metadata": {
    "createdAt": 1789084800000,
    "updatedAt": 1789088400000,
    "source": "urtoris",
    "tags": ["competition", "robot"]
  },
  "nodes": [
    {
      "id": "node_trigger",
      "type": "trigger",
      "name": "收到请求",
      "position": { "x": 80, "y": 220 },
      "ports": [
        { "id": "main.out", "label": "下一步", "kind": "main", "direction": "output", "dataType": "object", "required": true, "minConnections": 1, "maxConnections": null }
      ],
      "config": { "trigger": "webhook", "inputSchema": { "type": "object" }, "authPolicy": "urtoris-token" }
    },
    {
      "id": "node_agent",
      "type": "aiAgent",
      "name": "任务 Agent",
      "position": { "x": 390, "y": 220 },
      "ports": [
        { "id": "main.in", "label": "输入", "kind": "main", "direction": "input", "dataType": "object", "required": true, "minConnections": 1, "maxConnections": 1 },
        { "id": "main.out", "label": "输出", "kind": "main", "direction": "output", "dataType": "object", "required": true, "minConnections": 1, "maxConnections": null },
        { "id": "resource.model", "label": "Model", "kind": "model", "direction": "output", "dataType": "llm", "required": true, "minConnections": 1, "maxConnections": 1 },
        { "id": "resource.memory", "label": "Memory", "kind": "memory", "direction": "output", "dataType": "memory", "required": false, "minConnections": 0, "maxConnections": 1 },
        { "id": "resource.tools", "label": "Tools", "kind": "tool", "direction": "output", "dataType": "tool", "required": false, "minConnections": 0, "maxConnections": null }
      ],
      "config": { "strategy": "tools", "instructions": "识别任务并只调用允许的工具。", "maxIterations": 6, "timeoutMs": 30000, "fallbackPolicy": "rules", "rulesProfile": "competition-v1" }
    },
    {
      "id": "node_model",
      "type": "llmModel",
      "name": "Qwen Plus",
      "position": { "x": 360, "y": 510 },
      "ports": [
        { "id": "model.provider", "label": "Model", "kind": "model", "direction": "input", "dataType": "llm", "required": false, "minConnections": 0, "maxConnections": 1 }
      ],
      "config": { "provider": "openai-compatible", "model": "qwen-plus", "baseUrlRef": "dashscope-compatible", "allowBringYourOwnKey": true }
    },
    {
      "id": "node_robot_tool",
      "type": "tool",
      "name": "Robot Control",
      "position": { "x": 650, "y": 510 },
      "ports": [
        { "id": "tool.provider", "label": "Tool", "kind": "tool", "direction": "input", "dataType": "tool", "required": false, "minConnections": 0, "maxConnections": 1 }
      ],
      "config": { "name": "robot_control", "description": "执行白名单内机器人动作", "implementation": "robot", "inputSchema": { "type": "object", "required": ["action"] }, "timeoutMs": 5000, "policyRef": "robot-competition-v1", "idempotency": "required", "confirmation": "on-risk", "targetRef": "robot-main" }
    },
    {
      "id": "node_condition",
      "type": "condition",
      "name": "是否执行动作",
      "position": { "x": 750, "y": 220 },
      "ports": [
        { "id": "main.in", "label": "输入", "kind": "main", "direction": "input", "dataType": "object", "required": true, "minConnections": 1, "maxConnections": 1 },
        { "id": "branch.true", "label": "true", "kind": "branch", "direction": "output", "dataType": "object", "required": true, "minConnections": 1, "maxConnections": null },
        { "id": "branch.false", "label": "false", "kind": "branch", "direction": "output", "dataType": "object", "required": true, "minConnections": 1, "maxConnections": null }
      ],
      "config": { "expression": { "left": { "kind": "path", "value": "$.data.allowed" }, "operator": "eq", "right": { "kind": "literal", "value": true } }, "onEvaluationError": "fail" }
    },
    {
      "id": "node_output_yes",
      "type": "output",
      "name": "返回已执行",
      "position": { "x": 1080, "y": 150 },
      "ports": [
        { "id": "main.in", "label": "输入", "kind": "branch", "direction": "input", "dataType": "object", "required": true, "minConnections": 1, "maxConnections": null }
      ],
      "config": { "response": "执行完成" }
    },
    {
      "id": "node_output_no",
      "type": "output",
      "name": "返回已拒绝",
      "position": { "x": 1080, "y": 320 },
      "ports": [
        { "id": "main.in", "label": "输入", "kind": "branch", "direction": "input", "dataType": "object", "required": true, "minConnections": 1, "maxConnections": null }
      ],
      "config": { "response": "动作未获批准" }
    }
  ],
  "edges": [
    { "id": "edge_trigger_agent", "kind": "main", "source": { "nodeId": "node_trigger", "portId": "main.out" }, "target": { "nodeId": "node_agent", "portId": "main.in" } },
    { "id": "edge_agent_condition", "kind": "main", "source": { "nodeId": "node_agent", "portId": "main.out" }, "target": { "nodeId": "node_condition", "portId": "main.in" } },
    { "id": "edge_agent_model", "kind": "model", "source": { "nodeId": "node_agent", "portId": "resource.model" }, "target": { "nodeId": "node_model", "portId": "model.provider" } },
    { "id": "edge_agent_robot", "kind": "tool", "source": { "nodeId": "node_agent", "portId": "resource.tools" }, "target": { "nodeId": "node_robot_tool", "portId": "tool.provider" } },
    { "id": "edge_true", "kind": "branch", "source": { "nodeId": "node_condition", "portId": "branch.true" }, "target": { "nodeId": "node_output_yes", "portId": "main.in" }, "condition": { "branch": "true" } },
    { "id": "edge_false", "kind": "branch", "source": { "nodeId": "node_condition", "portId": "branch.false" }, "target": { "nodeId": "node_output_no", "portId": "main.in" }, "condition": { "branch": "false" } }
  ]
}
```

说明：Output 在接收 branch 时，端口 kind 必须是 `branch`；如果同一个 Output 同时允许 main 与 branch，应由注册表生成两个独立输入端口，不能让一个端口接受多 kind。

## 8. 发布校验

### Error：阻断发布

- 缺 Trigger 或多于一个 Trigger。
- 节点/边/端口 ID 重复或悬空。
- `main/branch` 成环或存在不可达节点。
- required 端口未连接或超过最大连接数。
- AI Agent 缺 Model，或绑定多个 Model/Memory。
- Condition 缺 true/false 分支。
- Tool 缺 input schema、policyRef 或 targetRef。
- Subworkflow 引用不存在、未发布或形成依赖循环。
- Adapter 不支持节点/配置，或 runtime binding 缺失。
- 配置中出现疑似明文凭据字段。

### Warning：允许保存，发布前需显式确认或修复

- Output 不可达、孤立的资源节点、节点标题重复。
- latestPublished 子工作流可能造成非确定性。
- Tool 没有幂等策略、Robot 动作需要人工确认。
- 图超过建议节点/边数量或预计超时预算。

```ts
export type GraphIssue = {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  path?: string;
};
```

## 9. 发布版本

```ts
export type WorkflowVersion = {
  id: string;
  workflowId: string;
  version: number;
  graph: WorkflowGraphV1;
  graphHash: string;
  adapter: 'n8n-v1';
  adapterVersion: string;
  compiledHash: string;
  externalWorkflowId?: string;
  webhookPath?: string;
  publishedAt: number;
  publishedBy?: string;
};
```

- `version` 发布时递增；同一版本永不覆盖。
- `graphHash` 对规范化 Graph 计算，不包含 viewport 和时间戳。
- `compiledHash` 用于判断 n8n 端是否漂移。
- 草稿 revision 与发布 version 独立。

## 10. Runtime Schema

```ts
export type ExecutionStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'error'
  | 'cancelled';

export type NodeRuntimeStatus =
  | 'idle'
  | 'waiting'
  | 'running'
  | 'success'
  | 'error'
  | 'skipped'
  | 'cancelled';

export type WorkflowExecution = {
  id: string;
  requestId: string;
  executionId?: string | null;
  sessionId?: string | null;
  workflowId: string;
  workflowVersion: number;
  graphHash: string;
  engine: 'n8n';
  mode: 'llm' | 'rules' | 'simulated';
  degraded: boolean;
  status: ExecutionStatus;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  outputRef?: string;
  error?: ExecutionError;
};

export type NodeExecutionState = {
  runId: string;
  nodeId: string;
  status: NodeRuntimeStatus;
  attempt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  inputRef?: string;
  outputRef?: string;
  error?: ExecutionError;
  lastSequence: number;
};

export type ExecutionEvent = {
  id: string;
  runId: string;
  requestId: string;
  executionId?: string | null;
  nodeId?: string | null;
  sequence: number;
  type:
    | 'workflow.started'
    | 'node.waiting'
    | 'node.started'
    | 'node.succeeded'
    | 'node.failed'
    | 'node.skipped'
    | 'tool.started'
    | 'tool.succeeded'
    | 'tool.failed'
    | 'workflow.succeeded'
    | 'workflow.failed';
  at: number;
  durationMs?: number;
  payloadRef?: string;
  message?: string;
};

export type ExecutionError = {
  code: string;
  message: string;
  nodeId?: string;
  retryable: boolean;
  detailRef?: string;
};
```

事件幂等键为 `(runId, sequence)`。Reducer 只接受比节点 `lastSequence` 更新的事件，避免重连、重复投递或乱序导致状态倒退。

## 11. 与现有模型的兼容投影

旧 `WorkflowStep[]` 只能进行保守迁移：

```text
WorkflowStep[]
  → Trigger（系统生成）
  → legacyStep(kind=input/transform/decision/compose/output) × n
  → Output（系统生成，可选）
```

不要把 `decision` 自动变成有业务含义的 true/false Condition，也不要把 `compose` 自动变成 AI Agent；旧数据没有表达式、模型、工具或分支目标，自动猜测会改变行为。

已绑定 `n8nWebhookUrl` 的记录应使用 `externalN8nWorkflow`：Graph 负责展示与启动，实际行为继续由原 Webhook 承担。等人工重建并通过 Adapter 等价测试后，再转换为 adapter-owned Graph。

## 12. Schema 演进

- 读取时按 `schemaVersion` 分派升级器，升级过程纯函数且可重复。
- 保存只写最新受支持版本；发布产物保留原版本与 Adapter 版本。
- v1 不删除未知 `extensions`，但任何未知核心字段都应报错。
- v2 候选：循环、动态分支、复合节点、可视分组、多人协作和秘密引用权限。
