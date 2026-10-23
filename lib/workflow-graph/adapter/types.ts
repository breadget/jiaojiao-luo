/**
 * Graph → n8n 编译器的公共类型。
 *
 * 这里刻意把"编译产物"和"绑定关系"分开：
 *  - `workflow` 是可以直接 import 进 n8n 的 JSON（**不含任何凭据**）；
 *  - `bindings` 是 internal nodeId ↔ n8n node id 的映射，落 `workflow_node_bindings`，
 *    运行时事件靠它把 n8n 的节点还原成 Studio 的节点。
 */
export type N8nConnectionTarget = {
  node: string;
  type: string;
  index: number;
};

/** n8n connections 的结构：节点名 → 连接类型 → 每个输出索引上的目标列表。 */
export type N8nConnections = Record<
  string,
  Record<string, N8nConnectionTarget[][]>
>;

export type N8nNode = {
  parameters: Record<string, unknown>;
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  notes?: string;
  notesInFlow?: boolean;
  disabled?: boolean;
  webhookId?: string;
  /** n8n 节点级失败策略；只允许 Adapter 显式编译的值进入产物。 */
  onError?: 'stopWorkflow' | 'continueRegularOutput' | 'continueErrorOutput';
};

export type N8nWorkflow = {
  name: string;
  nodes: N8nNode[];
  connections: N8nConnections;
  settings: Record<string, unknown>;
  active: boolean;
  meta: Record<string, unknown>;
};

export type AdapterIssue = {
  level: 'error' | 'warning';
  message: string;
  nodeId?: string;
};

export type CompiledNodeBinding = {
  internalNodeId: string;
  externalNodeId: string;
  externalNodeName: string;
  role: string;
};

export type CompileStats = {
  internalNodes: number;
  externalNodes: number;
  connections: number;
  /** 因为所属节点不支持而被拒绝编译的节点数。 */
  unsupportedNodes: number;
};

export type CompileResult = {
  ok: boolean;
  adapter: string;
  adapterVersion: string;
  /** 可直接导入 n8n 的产物；ok=false 时为 null（绝不留半成品）。 */
  workflow: N8nWorkflow | null;
  bindings: CompiledNodeBinding[];
  compiledJson: string | null;
  compiledHash: string | null;
  graphHash: string;
  issues: AdapterIssue[];
  /**
   * 产物里**故意不写**、需要运维在克隆环境手工挂载的凭据引用。
   * 这是"去凭据编译"的正面表达：不写进 JSON，但也不假装不需要。
   */
  requiredCredentialRefs: string[];
};

export type CompileOptions = {
  /** 工作流 id（用于确定性节点 id）。 */
  workflowId: string;
  /** 发布版本号（用于确定性节点 id）；预览时传"即将分配的版本"。 */
  version: number;
  /** 触发路径；不给时按 workflowId 确定性生成。 */
  webhookPath?: string;
};
