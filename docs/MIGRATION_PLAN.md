# Workflow Studio 迁移计划

> 状态：Phase 0 完成；Phase 1、Phase 2、Phase 4 已完成首个切片。
> **Phase 3 Adapter（第一版，9 种节点）与不可变发布快照已实现并有自动化测试覆盖**，
> 详见 [`WORKFLOW_GRAPH_RELEASE.md`](WORKFLOW_GRAPH_RELEASE.md)。
> 仍未实施：Phase 5 真实事件流、Graph 与旧 steps 的原子双写、克隆环境 canary 与生产迁移。
> Studio 的 Deploy 在 canary 通过前保持锁定。
>
> 优先级：必须做｜难度：High

## 1. 迁移目标与红线

目标是在不破坏现有发布、调用和 n8n 工作流的前提下，把工作流事实源从 `WorkflowStep[] + webhook URL` 迁移为独立的 Internal Graph。

红线：

- 不重写 n8n 执行引擎。
- 不直接修改生产 n8n 数据库或未导出的生产工作流。
- 不把现有 `WorkflowStep[]` 猜测为真实 n8n 图。
- 不开放当前已关闭的公网 n8n Public API 来换取开发便利。
- 不改变 `/api/v1/run` 的 `urtoris.v1` 响应契约。
- 不提交真实 Key、令牌、凭据、Webhook 鉴权头或生产导出中的 credentials。
- 所有迁移 add-only；旧路径在新路径完成等价验收前可立即恢复。

## 2. 基线与已知事实

基线提交为 `c0c1302`。

当前事实源：

```text
workflows.draft_steps_json
workflows.published_steps_json
workflows.n8n_webhook_url
```

当前站点只知道线性展示步骤，实际 n8n 工作流在 ECS 中。仓库只保存运维、补丁与 canary，不保存完整生产 n8n JSON。因此迁移分成两类：

| 类型 | 判断 | 初始迁移方式 |
| --- | --- | --- |
| 模拟工作流 | `n8n_webhook_url IS NULL` | 线性 `legacyStep` 图，继续模拟运行 |
| 已绑定 n8n | `n8n_webhook_url IS NOT NULL` | `externalN8nWorkflow` opaque 节点，继续调用原 Webhook |

只有人工重建或 Adapter 自己生成的工作流，才能成为可完整编辑、可双向映射的 Graph。

## 3. 目标持久化模型

推荐新增表，而不是立即改写现有 JSON：

### `workflow_graph_drafts`

| 字段 | 用途 |
| --- | --- |
| `workflow_id` PK | 对应现有 workflows |
| `schema_version` | Internal Graph 版本 |
| `revision` | 草稿乐观锁 |
| `graph_json` | 完整草稿 Graph |
| `graph_hash` | 规范化内容哈希 |
| `updated_at` | 保存时间 |
| `updated_by` | 可选审计主体 |

### `workflow_versions`

| 字段 | 用途 |
| --- | --- |
| `id` PK | 不可变版本 ID |
| `workflow_id` | 工作流 |
| `version` | 业务版本号，联合唯一 |
| `schema_version` | Graph schema |
| `graph_json` | 发布快照 |
| `graph_hash` | 业务内容哈希 |
| `adapter` / `adapter_version` | 编译器身份 |
| `compiled_json` | 去凭据 n8n 产物，可选压缩/外置 |
| `compiled_hash` | 检测漂移 |
| `external_workflow_id` | n8n ID |
| `webhook_path` | 相对路径，不保存鉴权 |
| `published_at/by` | 发布审计 |

### `workflow_node_bindings`

| 字段 | 用途 |
| --- | --- |
| `workflow_version_id` | 发布版本 |
| `internal_node_id` | Studio 节点 |
| `external_node_id` | n8n node id |
| `external_node_name` | n8n 稳定名称 |
| `role` | primary/wrapper/helper |

同一个内部节点可编译为多个 n8n 节点，因此主键建议 `(workflow_version_id, internal_node_id, external_node_id)`。

### `run_node_states` 与 `run_events`

- `run_node_states` 保存每个节点最新状态，供快速读取。
- `run_events` 保存有界时间线，唯一键 `(run_id, sequence)`。
- 当前 `n8n_events` 可作为原始事件 inbox，归一后再写上述两表；不要立即删除。
- `run_claims` 应补入 `db/schema.ts`，结束“迁移里有、类型定义里没有”的状态。

## 4. Phase 0：设计评审

**优先级：必须做｜难度：Low**

交付：

- `CURRENT_ARCHITECTURE.md`
- `WORKFLOW_SCHEMA.md`
- `WORKFLOW_UI_DESIGN.md`
- `MIGRATION_PLAN.md`

退出条件：人工确认 Graph 方向、旧工作流兼容方式、Studio 路由、Adapter 部署边界和第一版范围。未明确“开始实施”前停在此阶段。

## 5. Phase 1：Domain Foundation

**优先级：必须做｜难度：Medium**

只加入纯类型和纯函数，不改变运行路径：

1. 建立 `lib/workflow-graph/types.ts`。
2. 建立 Node Registry，定义默认配置、端口和风险等级。
3. 实现 `validateGraph`、cycle/reachability/cardinality 校验。
4. 实现规范化与稳定 `graphHash`。
5. 实现 Graph ↔ CanvasProjection，无 React Flow 依赖也能单测。
6. 加入 fixture：合法 Agent 图、缺 Model、Tool 一对多、Condition 分支、循环、悬空端口、未知节点。

退出条件：类型检查、validator tests 和 snapshot tests 全通过；现有 API 输出字节级兼容。

## 6. Phase 2：Persistence 与双读

**优先级：必须做｜难度：High**

1. 新增 `0007_workflow_graph.sql`，只 CREATE 新表/索引，不 DROP 旧字段。
2. 更新 `db/schema.ts`，同时补齐 `run_claims`。
3. 增加 Graph Store，所有写入带 revision 条件：

```sql
UPDATE workflow_graph_drafts
SET graph_json = ?, graph_hash = ?, revision = revision + 1, updated_at = ?
WHERE workflow_id = ? AND revision = ?;
```

4. `GET /api/workflows/:id/graph` 读取优先级：

```text
已有 graph draft → 返回
否则 legacy projector → 只在内存生成 → 首次显式保存时入库
```

5. 旧 `POST /api/workflows` 继续写 steps；若 Graph 已存在，禁止它覆盖非线性 Graph，返回明确冲突并引导 Studio。
6. 新 Studio 保存 Graph 时，不反向生成虚假的 steps。只有“严格线性且节点可投影”时才生成旧 steps 兼容视图。

退出条件：生产数据副本迁移成功；旧页面读写未回归；revision 冲突测试通过。

## 7. Legacy Projector

**优先级：必须做｜难度：Medium**

### 未绑定 n8n

保守转换：

```text
system Trigger
  ↓
legacyStep[0]
  ↓
legacyStep[1]
  ↓
...
  ↓
system Output
```

保留每个旧 step 的 `id/title/detail/kind/index`。即使 `kind=decision` 也不创建 true/false 分支；旧数据没有条件表达式和分支目标。

### 已绑定 n8n

Graph 包含：

```text
Trigger → externalN8nWorkflow → Output
```

`externalN8nWorkflow.config` 只保存服务器认可的 binding id 或相对 webhook path，不在 Graph 返回完整外部 URL。旧步骤作为只读 `displayManifest` 附在兼容节点扩展里，不参与执行。

### 何时转成原生 Graph

- 人工在 Studio 中重建。
- 从去凭据 n8n export 导入为 opaque/已支持节点。
- 通过行为 fixture、协议、W1/W4 canary 和并发映射测试。
- 发布新 Graph 版本后，旧 external binding 仍保留为一键回滚目标。

## 8. Phase 3：n8n Adapter

**优先级：必须做｜难度：High**

### 8.1 Compiler pipeline

```text
Graph
 → validate
 → normalize
 → compile nodes
 → compile main/branch edges
 → compile model/memory/tool/subworkflow relations
 → inject auth/envelope/early-binding/event/response wrappers
 → validate n8n JSON
 → emit compiled JSON + node map + hashes + warnings
```

### 8.2 稳定标识

- n8n node name：`U::<shortInternalId>::<role>`，显示名放 notes/metadata。
- n8n node id：由 `workflowId + version + internalNodeId + role` 确定性生成。
- `workflow_node_bindings` 记录一对多关系。
- 所有事件在 common log 前把 n8n node id 转换为 internal nodeId。

### 8.3 导入范围

| 输入 | 处理 |
| --- | --- |
| Adapter 生成并带 metadata | 保证可逆 |
| 已支持标准 n8n 节点 | 映射为 Internal Node，保留不认识的参数扩展 |
| 未支持节点 | `n8nOpaque`/external 节点，只读 |
| credentials | 仅保留 credentialRef/stub，绝不导入 secret |
| Code 任意脚本 | 默认 opaque/high risk，不自动翻译为 Transform |

### 8.4 部署边界

生产 `N8N_PUBLIC_API_DISABLED=true` 保持不变。第一版：

1. 网站编译并保存去凭据产物。
2. 运维命令在 ECS 本地导出备份。
3. 在克隆实例导入、发布并运行 canary。
4. 生产变更仍由受控 CLI/本机流程执行。

未来如需自动部署，应设计仅能管理 Adapter-owned workflow 的内网部署代理，而不是向公网开放通用 n8n API。

退出条件：golden fixture 稳定；重复编译 hash 一致；克隆环境执行语义一致；未知节点不丢失。

## 9. Phase 4：Studio MVP 灰度

**优先级：必须做｜难度：High**

1. 新增 `/studio`，默认功能开关关闭。
2. 仅通过管理员鉴权进入编辑模式。
3. 加入 `@xyflow/react`，实现 Node Palette、Canvas、Inspector、Validation、Save/Publish。
4. 第一版只实现计划范围：拖拽、连线、Agent 资源端口、Condition、保存、运行、节点状态。
5. 旧 `/` 创建端保持完整可用；Studio 失败时关闭功能开关即可回退。
6. 不在 `components/workflow-lab.tsx` 中直接堆画布逻辑。

退出条件：MVP UI 验收、键盘/触控基本可用、100 节点性能基线通过、旧功能全回归。

## 10. Phase 5：Runtime Event Pipeline

**优先级：必须做｜难度：High**

### 10.1 API 迁移

新增异步入口：

```text
POST /api/workflows/:id/runs → 202 {runId, requestId}
GET  /api/runs/:runId
GET  /api/runs/:runId/events?after=42
GET  /api/runs/:runId/stream
```

旧 `/api/runs`、`/api/agent/chat`、`/api/v1/run` 继续等待终态并返回旧形状。

### 10.2 Event reducer

- n8n event ingress 仍使用 `URTORIS_INTERNAL_TOKEN`。
- ingress 校验大小、数量、requestId/executionId/node mapping。
- 写原始 inbox 后转换为 Internal Event。
- `(run_id, sequence)` 唯一；重复投递不重复改变状态。
- 事件乱序时只更新更大的 `last_sequence`。
- Input/Output/payload 超过阈值写引用或截断；入库前统一脱敏。

### 10.3 n8n 事件点

每个编译节点至少发：

```text
node.waiting（可选，由调度层推断）
node.started
node.succeeded | node.failed | node.skipped
```

Agent Tool 的每次调用发 tool 子事件；所有事件继承 requestId、executionId、sessionId、workflowVersion 和 internal nodeId。

退出条件：SSE 重连、并发隔离、重复事件、乱序、失败和降级测试全部通过。

## 11. Phase 6：数据迁移与生产灰度

**优先级：必须做｜难度：High**

### 11.1 生产前

1. 备份 `/opt/urtoris/app`、D1 持久化目录、`.dev.vars`、Nginx、systemd 和 n8n 数据目录。
2. 在生产 D1 副本跑 0007，记录表数量、工作流数量、版本与 hash。
3. 导出去凭据的 n8n 工作流副本，仅用于 Adapter fixture 和克隆环境。
4. 完成 lint、typecheck、build、Graph validator、Adapter golden、API contract 与 UI tests。

### 11.2 灰度顺序

1. 先部署读路径和关闭状态的 feature flag。
2. 迁移一个无 n8n 的模拟工作流。
3. 迁移 W1 这类无副作用工作流。
4. 运行 W1 并发、终态、requestId/executionId 和 mode/degraded canary。
5. 迁移 W4 并运行目标白名单 canary。
6. 最后才考虑用户管理、客户洞察和 Robot Tool。

### 11.3 观察指标

- Graph save/publish error rate。
- Adapter compile failure/warning count。
- run success/error/degraded 分布。
- SSE 断线与事件延迟。
- requestId 重放/冲突/claim 超时。
- internal node mapping miss。
- n8n 陈旧 `status='running'` 数量。
- D1 event 写入量和存储增长。

退出条件：至少一个低风险工作流完成真实 Studio → Adapter → n8n → Runtime UI 闭环，并在观察窗口内无 P0/P1 回归。

## 12. 回滚设计

回滚单位分开控制：

| 层 | 回滚方式 |
| --- | --- |
| UI | 关闭 `WORKFLOW_STUDIO_ENABLED`，入口回旧创建端 |
| API | 新端点停止使用，旧端点不变 |
| Graph read | 切回 legacy projector/steps |
| Runtime | 发布版本 binding 指回原 external Webhook |
| n8n | 恢复导出与 SQLite 备份，重新 Publish 原工作流 |
| D1 | 新表保留不读；不通过 DROP 回滚 |

任何回滚都不得使用 `git reset --hard` 或直接覆盖生产数据。回滚脚本以备份目录、版本 ID 和明确服务状态为输入，并在恢复后执行 readiness、W1/W4 和只读检查器。

## 13. 兼容矩阵

| 场景 | 迁移期间行为 |
| --- | --- |
| 旧创建端保存旧线性工作流 | 继续可用；未存在原生 Graph 时正常保存 |
| 旧创建端尝试覆盖非线性 Graph | 409，要求进入 Studio |
| `/api/state` | 保持公开 DTO；可新增 `studioAvailable`，不暴露 Graph 配置 |
| `/api/v1/run` | 请求/响应保持 `urtoris.v1` |
| 旧 Webhook 工作流 | external binding 原样运行 |
| 新 Graph 工作流 | 由 Adapter 编译后运行 |
| 无 Key | `mode=rules, degraded=true` |
| 错误 Key | 明确 LLM error，不静默降级 |
| 同 requestId 重试 | 重放同一 run，不重复触发副作用 |
| 两个并发 requestId | node events、executionId、session 不串号 |

## 14. 测试矩阵

### Graph

- ID、端口、cardinality、DAG、reachability、Condition、Agent resources、Subworkflow cycle。
- schemaVersion upgrade、未知 extensions、Graph hash 稳定。

### Adapter

- 每种节点的 golden JSON。
- Agent + 多 Tool + Memory + Model connection。
- true/false 输出索引。
- stable IDs、重复编译、未知节点、凭据剥离。
- n8n 当前版本与候选升级版本 fixture。

### Runtime

- 正确/错误/无 Qwen Key、断网、超时、异常响应。
- 事件重复、乱序、丢失、重连、超大 payload。
- 相同/不同 requestId 并发与 session 隔离。
- Tool/Robot 幂等和策略拒绝。

### UI

- 拖拽/点击添加、合法/非法连线、保存恢复、revision 冲突。
- 发布阻断、历史版本、运行状态和 Inspector。
- 键盘、reduced motion、窄屏、100 节点性能。

### 回归

- 现有 oxlint、`tsc --noEmit`、Vinext build。
- `/api/state` 公开 DTO 安全字段断言。
- 管理员鉴权、同源策略、限流、体积上限、Webhook 白名单。
- W1/W4 canary、n8n audit、execution finalization。

## 15. 实施任务拆分

建议按可独立评审的提交拆分：

1. `docs: approve workflow studio architecture`
2. `feat(graph): add schema registry and validator`
3. `feat(graph): add persistence and legacy projector`
4. `feat(adapter): compile internal graph to n8n fixtures`
5. `feat(studio): add feature-flagged canvas shell`
6. `feat(studio): add agent resources and condition editing`
7. `feat(runtime): add node event projection and stream`
8. `test(studio): add contract and end-to-end matrix`
9. `ops(studio): add clone canary and rollback runbook`

每个提交必须保持旧站点可构建、旧 API 可用，不把生产部署和应用代码提交绑在同一步。

## 16. Go / No-Go 清单

### 开始编码前

- [ ] 人工批准四份设计文档。
- [ ] 明确回复“开始实施”。
- [ ] 确认首个迁移工作流与 feature flag 名称。
- [ ] 获取去凭据 n8n 导出 fixture，而不是生产 secret。

### 上生产前

- [ ] 数据和配置备份可恢复。
- [ ] 0007 在 D1 副本通过。
- [ ] Graph/Adapter/Runtime/UI/安全回归全绿。
- [ ] W1/W4 在克隆环境通过。
- [ ] 旧 Webhook binding 和 UI 开关可回滚。
- [ ] 生产不升级 n8n，不与 Studio 首发合并风险。
