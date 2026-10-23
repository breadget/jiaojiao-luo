# 工作流程序运行

`program-v1` 将创建端保存的画布编译为原生程序。发布时固定图、输入字段、节点配置和版本；运行时服务器读取该版本执行，浏览器只提交输入和共用模型设置。任务由独立 Node 服务在后台调度，页面负责查看状态、取消和下载结果。

本文描述原生程序路径。现有 n8n 绑定、本机 SQLite、Python Executor 和本机 Control Agent 保留各自协议，不会因为画布上出现对应节点就自动成为原生程序能力。

## 使用步骤

1. 进入创建端，在工作流列表选择“课程原文导出”或“课程学习文档”，或用支持的节点编辑画布。
2. 保存草稿，检查编译提示，然后点击“发布可运行程序”。创建模板只会保存草稿；发布不会自动运行。
3. 点击“运行程序”进入 `/ai?program=<workflowId>`，或在 AI 工作台装载该程序。
4. 展开“运行程序”，填写发布版本定义的参数。包含 AI 节点时，先在工作台设置中配置共用模型。
5. 提交后查看真实节点状态。可以关闭详情或刷新页面；正在执行的任务仍由后台服务持有。
6. 完成后阅读结果与课程来源，并下载输出节点生成的文件。调整参数后再次运行会创建新任务。

“课程原文导出”走输入 → 课程检索 → Markdown 输出，不调用生成模型。“课程学习文档”创建的画布名称为“课程练习生成器”，走输入 → 课程检索 → AI Agent → Markdown 输出，Model 资源说明其使用工作台共用模型。主题、难度和数量来自输入表单；资料不足或模型失败会返回真实错误。

统一智能体对话仍保留原聊天框、会话历史和课程问答。装载程序本身不执行；明确的执行请求可以启动当前发布程序，回复中的运行入口指向该次后台任务。参数较复杂时直接使用运行表单。

## 支持的画布

| 节点 | 执行行为 |
| --- | --- |
| `trigger` | 接收声明的文本、数字、布尔参数，应用默认值并校验必填、类型和范围 |
| `courseKnowledge` | 将查询发给本机 Django 知识检索接口，返回真实原文、文件名与页码 |
| `aiAgent` | 用共用模型处理当前输入和已检索资料；课程生成需要有效来源引用 |
| `condition` | 对标量或字段引用进行一次比较，只执行 `true` / `false` 中选中的分支 |
| `transform` | 按 JSON 对象映射生成下游数据，不执行脚本 |
| `output` | 返回文字或数据，可额外生成 `text/plain` / `text/markdown` 文件 |
| `llmModel` | 通过 Model 资源端口连接 Agent；实际供应商、端点、模型、密钥及推理设置统一取运行时设置 |
| `memory` | 为同一次任务内相连的 Agent 提供记忆，不跨任务持久保存模型会话 |

图必须有一个 Trigger，所有执行路径最终到达 Output。最多 64 个节点。Condition 各有一条 `true` 和 `false` 连接；第一版不支持循环、并行扇出或分支汇合，分支需连接各自独立的 Output。发布时拒绝不支持的节点、任意代码、图内凭据和含凭据的地址。

HTTP、机器人、数据库、子工作流及任意 JavaScript / Python / Shell 不属于 `program-v1`。需要这些能力时使用原有独立执行路径；原生程序不会把它们改成模拟成功。暂停、断点、单步与循环控制也尚未提供。

## 输入与数据传递

Trigger 的 `config.inputFields` 定义运行表单；未配置时默认一个必填文本字段 `message`。字段数量为 1–32，输入 JSON 总量最多 32 KiB。未知字段、类型错误、非法凭据字段和超出范围的值会被拒绝。

```json
{
  "inputFields": [
    { "name": "topic", "label": "课程主题", "type": "text", "required": true, "min": 1, "max": 1000 },
    { "name": "count", "label": "练习数量", "type": "number", "default": 5, "min": 1, "max": 20 },
    { "name": "includeAnswers", "label": "附带答案", "type": "boolean", "default": true }
  ]
}
```

文本的 `min` / `max` 表示长度，数字表示值域。程序不会将字符串自动当作数字或布尔值。

配置中的变量只读取实际存在的数据，不运行表达式：

| 引用 | 含义 |
| --- | --- |
| `{{input.topic}}` | 本次经校验的原始输入 |
| `$json.text` 或 `{{$json.text}}` | 当前上游节点输出的字段 |
| `{{nodes.course_sources.text}}` | 当前执行路径中已经完成的指定节点输出 |
| `{{steps.course_sources.output.text}}` | 指定节点输出的兼容写法 |

整个值只有一个变量时保留其原类型，嵌入普通文字时转为文本。引用未执行节点、缺失字段或原型属性会报错。Transform 的 `config.mapping` 可以是 JSON 对象或对象的 JSON 字符串；它生成新的下游对象。Condition 保留输入数据供选中的分支继续使用。

```json
{
  "left": "{{input.count}}",
  "operator": ">",
  "right": 5
}
```

条件支持严格相等、不等、数字大小比较、字符串 `contains` 和 `exists`；`==` / `!=` 也使用严格类型比较。可使用单次比较的 `expression` 兼容字段，但不支持 JavaScript。

课程节点的 `query` 接受文本或变量，`maxSources` 为 1–20 的整数或解析为整数的变量；它只限制实际返回来源数量，不保证知识库一定有这么多匹配。Output 的 `artifact` 可配置安全文件名和 MIME 类型，例如：

```json
{
  "text": "$json.text",
  "artifact": { "name": "course-exercises.md", "mimeType": "text/markdown" }
}
```

## 发布、状态与恢复

发布接口复用 Graph 草稿 revision 与内容哈希冲突校验，将规范化快照和编译结果固化为不可变 `workflow_versions` 记录，再移动活动发布指针。`program-v1` 原生执行无需向 n8n 导入 JSON。编辑草稿不会改变已发布程序，也不会改变已经启动任务的图、字段或版本。

提交任务包含 `versionId`，避免表单打开后新版本发布导致误用新输入定义。相同请求 ID 的重试回到原任务；变更输入或版本后重新运行需要新的请求 ID。程序服务也按内部任务 ID 去重，不自动重复执行不确定的请求。

任务状态为 `queued`、`running`、`completed`、`failed`、`cancelled`。节点状态为 `waiting`、`running`、`success`、`error`、`skipped`。未选中的分支标为跳过；开始与结束时间来自真实执行回调。提交成功只表示已排队，不表示程序完成。

取消会中断排队或活动任务；取消后不会启动新节点，也不会把迟到的返回写成成功。供应商可能已经收到取消前发出的请求，取消不撤销对方已处理的工作。当前服务最多同时运行 2 个任务、另排队 8 个任务，执行上限为 5 分钟。课程检索与模型调用各有独立的时间及响应大小限制。

任务快照和文本文件写入独立持久目录，主站保存归属关系及可恢复快照。刷新后由所属匿名会话恢复任务。浏览器匿名会话不是正式账号，清除会话凭据会失去相应访问身份。

服务重启时，遗留的排队或运行任务标为 `failed`，错误码 `WORKER_RESTARTED`；任务不会自动重跑。完成记录和已生成文件可继续读取，前提是持久目录未丢失。失败后如需再试，由用户新建一次运行。

## 共用模型与数据边界

课程问答、统一智能体判断和程序 AI 节点沿用主站同一套 `LlmConfig`。画布里的 Model 资源不保存另一套凭据。纯原文导出无需模型；需要 AI 的程序未配置模型时不会伪装生成回答。

模型设置随启动请求临时传给 loopback 程序服务，API Key 仅保留在运行内存，不写发布图、任务快照、运行记录、日志或输出文件。服务会清理错误或模型返回中回显的凭据。课程 Django 只收到检索问题，不收到模型密钥。

课程原文、用户输入与模型生成内容都是数据，不能改写发布图或授权新工具。下载按任务归属和受控产物 ID 查询，浏览器不能指定服务器文件路径。原生程序只生成 TXT / Markdown，不执行生成的文件。

## API

浏览器 API 继承主站执行访问策略、同源检查、速率限制和匿名会话归属检查；管理模板与发布仍需管理员权限。接口返回 `Cache-Control: no-store`。这里的公开元数据不包含原始画布或凭据。

| 方法与路径 | 请求 / 返回 |
| --- | --- |
| `GET /api/programs?workflowId=...` | 返回 `{ program, available }`；非活动原生程序的 `program` 为 `null`。元数据含 `versionId`、`workflowVersion`、`inputFields`、节点名称及 `requiresModel` |
| `POST /api/programs/runs` | 提交 `{ workflowId, versionId, requestId, input, llm, consumerSessionId? }`，返回 `202 { job, consumerSessionId, replayed }`；新会话同时设置归属 Cookie |
| `GET /api/programs/runs?workflowId=...&consumerSessionId=...` | 返回该会话所属程序的最近任务 `{ jobs }`；省略会话时使用当前浏览器的统一对话会话 |
| `GET /api/programs/runs/:id` | 返回 `{ job }`，从程序服务同步真实进度 |
| `DELETE /api/programs/runs/:id` | 取消所属任务，返回 `{ job }` |
| `GET /api/programs/runs/:id/artifacts/:artifactId` | 下载该任务已登记的文本附件，校验实际字节数 |
| `POST /api/programs/templates` | 管理接口，`{ kind: "course-learning" \| "course-retrieval" }` 创建草稿并返回 `{ workflow, graph }` |
| `POST /api/workflows/:id/graph/publish` | 管理接口，使用 `{ expectedRevision, executionTarget: "program", expectedGraphHash? }` 发布已保存草稿 |

启动请求不能覆盖 `graph`、`plan`、编译产物或服务器路径。只提交输入，不把整张图从浏览器当作可执行计划。`job` 包含任务 ID、固定版本、状态、输入、节点快照、最终结果、产物描述及时间戳；不包含模型密钥。

内部 `/v1/jobs` 只供主站调用，采用另一个至少 32 字符的内部令牌并监听 loopback，不能直接暴露给公网。完整服务配置与协议见 [程序服务说明](../services/workflow-program/README.md)。

## 本地启动与运行文件

使用 Node.js 22.13 或更新版本，先 `npm ci`。主站 `.dev.vars` 配置 `WORKFLOW_PROGRAM_URL=http://127.0.0.1:8030` 和内部 `WORKFLOW_PROGRAM_TOKEN`，程序进程环境使用同一个令牌。两个终端分别运行：

```bash
npm run dev:course
```

```bash
npm run program:dev
```

第二条命令只启动程序服务，不会自动启动主站或课程服务，也不会自动把环境令牌写入主站配置。`WORKFLOW_PROGRAM_STATE_DIR` 默认为项目下 `work/workflow-program`；生产部署应置于发布目录外。`WORKFLOW_PROGRAM_PORT` 默认 `8030`；`COURSE_ASSISTANT_URL` 默认 `http://127.0.0.1:8001`。

新增迁移 [`0013_workflow_program_jobs.sql`](../drizzle/0013_workflow_program_jobs.sql) 保存主站任务归属、请求去重与快照；升级部署时应应用该迁移，并保留程序服务的持久目录。systemd 单元见 [`deploy/urtoris-workflow-program.service`](../deploy/urtoris-workflow-program.service)。本文不代表某个环境已部署或已通过现场验收。

## 代码入口

- 编译与不可变快照：[`lib/workflow-graph/adapter/program.ts`](../lib/workflow-graph/adapter/program.ts)
- 数据绑定、校验与执行：[`lib/workflow-program/`](../lib/workflow-program/)
- 调度、取消、持久化与课程传输：[`services/workflow-program/`](../services/workflow-program/)
- 版本、会话归属与任务记录：[`lib/server/workflow-program-store.ts`](../lib/server/workflow-program-store.ts)
- 运行表单与真实状态面板：[`components/program/`](../components/program/)
- 界面方向与行为约定：[`WORKFLOW_PROGRAM_SURFACE.md`](WORKFLOW_PROGRAM_SURFACE.md)
