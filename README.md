> **来源与贡献：** 本分支由 [@breadget](https://github.com/breadget) 导入和维护，包含协作或第三方成果；历史作者与许可见 [ATTRIBUTION.md](ATTRIBUTION.md)。新的提交记录表示导入与维护，不代表全部代码为个人独立原创。

# Urtoris

## 数据结构与算法助教考核项目

首页的**询问 AI 智能体**统一了工作流对话和课程知识问答。
进入 `/ai` 后，课程知识与工作流使用同一个聊天框和模型设置。智能体检索课程原文回答问题；用户明确要求执行任务时，才可调用已装载的工作流。切换工作流保留当前对话，未装载工作流也可提问课程知识。
首页保留“创建工作流端”，暂时隐藏机器人入口。旧的 `/course` 地址也可进入统一工作台。
课程检索后端位于
[`course-assistant/`](course-assistant/README.md)，采用 Python、Django、SQLite、LangChain 和 FAISS。

同时启动主站和课程服务：

```bash
npm run dev:course
```

打开 `http://localhost:3000/ai`。命令会准备 Python 环境、建立知识库索引，
并复用已经运行的课程服务；关闭命令只停止由本次启动的课程进程。
主站 `/api/agent/chat` 用现有模型服务、API Key、模型和推理设置处理统一对话，服务器向本机 Django 的 `/api/retrieve/` 请求课程原文。Django 检索不接收聊天模型密钥、不生成回答；浏览器只访问主站。
正式站点可设置 `COURSE_ASSISTANT_PUBLIC_ORIGIN=https://urtoris.cn`，只开放该站点的课程状态和提问接口；默认仍仅本机可用，后台服务始终监听 loopback。生产课程服务与持久化配置见 [部署文档](deploy/README.md)。
在主站“设置”中配置一次模型即可用于课程回答与工作流。未配置密钥时只提供原文检索；提供的模型配置调用失败会如实显示错误。独立 Django 页面启动方法见子项目说明。

Urtoris 是一个工作流双端原型：

- **创建工作流端**：编辑、保存并发布多个工作流。
- **询问 AI 智能体**：检索课程、直接对话，或装载已发布程序，填写参数后运行并查看真实节点状态、结果和文件。

当前版本从首页选择“创建工作流端”或“询问 AI 智能体”进入工作台，暂不包含真实账号鉴权。

## 本地启动

```bash
npm ci
npm run dev
```

默认访问 `http://localhost:3000` 即可查看。

## 把工作流作为程序运行

创建端提供“课程原文导出”和“课程学习文档”模板。创建模板后，保存画布并点击“发布可运行程序”，再进入 AI 工作台的“运行程序”面板填写主题等参数。模板创建本身不会发布或执行任务。

`program-v1` 在后台执行固定的发布版本，依次传递节点数据并按条件选择分支。刷新页面后可恢复查看状态；运行中可取消，完成后可下载 TXT 或 Markdown 文件。课程节点调用现有知识库，AI 节点复用主站同一组模型、API Key、端点和推理设置。纯原文导出无需模型密钥。

本地运行需要主站、课程服务和程序服务。先在主站本地 `.dev.vars` 配置 `WORKFLOW_PROGRAM_URL=http://127.0.0.1:8030` 与一个至少 32 字符的 `WORKFLOW_PROGRAM_TOKEN`，并在单独终端设置相同令牌后运行：

```bash
npm run program:dev
```

另一个终端运行 `npm run dev:course`。令牌只用于两个本机服务通信，不是模型密钥，不要提交到仓库。

第一版支持输入、课程检索、AI Agent、条件、字段映射和输出，以及 Model / Memory 资源；循环、分支汇合、HTTP、机器人和任意代码不在原生程序范围内。完整输入格式、发布与 API 约定见 [`docs/WORKFLOW_PROGRAM.md`](docs/WORKFLOW_PROGRAM.md)，服务配置见 [`services/workflow-program/README.md`](services/workflow-program/README.md)。

## 工作流连接电脑上的 SQLite

在存有数据库的电脑上使用 Node.js 22.13 或更高版本，运行：

```bash
npm ci
npm run database:local
```

打开 `http://127.0.0.1:3022/connect`，点击“打开工作台并连接”，再在数据库
节点选择或填写本机 SQLite 文件的绝对路径、测试连接并连接到 AI Agent。
保持助手运行，即可在 `https://urtoris.cn` 的工作流对话中查询本机数据库。
数据库只读，原文件不会上传；模型会收到必要的表结构和查询结果。
完整连接步骤和当前范围见 [`docs/LOCAL_DATABASE.md`](docs/LOCAL_DATABASE.md)。

## 备案期间访问 ECS 站点

备案生效前，可以用 SSH 本地转发访问 ECS 上的 Urtoris：

```bash
npm run ecs:site
```

保持该终端运行，然后打开 `http://127.0.0.1:13000`。浏览器不经过
`urtoris.cn`，网站后端仍在 ECS 内通过回环地址调用 n8n；服务器的
n8n 端口不会因此暴露到公网。

默认使用 `~/.ssh/urtoris-ecs` 和 `root@8.133.252.143`。需要覆盖时使用
`URTORIS_ECS_KEY`、`URTORIS_ECS_HOST` 或 `URTORIS_LOCAL_SITE_PORT`。

## 检查与构建

```bash
npm run lint
npm run build
```

## API

旧工作流可通过 `POST /api/v1/run` 调用。请在服务器本地的 `.dev.vars` 中配置 `URTORIS_API_TOKEN`，不要将密钥提交到仓库。原生程序使用 `POST /api/programs/runs` 提交，随后按返回的任务 ID 查询状态；接口契约见 [程序文档](docs/WORKFLOW_PROGRAM.md#api)。

使用端页面内的 Agent 对话通过 `POST /api/agent/chat` 完成，请求体为 `{ "workflowId": "...", "message": "..." }`，无需额外密钥。

## Python Executor 与 Agent

仓库包含一个独立、loopback-only 的 Python Executor、`/api/python/*` 受控转发接口，以及按 [`docs/python-agent-system-prompt.md`](docs/python-agent-system-prompt.md) 实现的 Agent 状态机（`/api/python/agent`）：注入 task 与受控 `file_id` 上下文、把 `run_python` 作为工具下发给模型、最多三次尝试、按 `error_fingerprint` 与错误类型决定是否修复，并用确定性模板保证失败不会被写成成功。

Agent 入口默认关闭：只有显式设置 `PYTHON_AGENT_ENABLED=1` 且 Executor 已按 loopback + 内部 token 配置时才会启用，真实容器的九项安全门禁通过前不要打开。启动、镜像和 canary 说明见 [`services/python-executor/README.md`](services/python-executor/README.md)，协议与安全基线见 [`docs/python-executor-mvp.md`](docs/python-executor-mvp.md)、[`docs/tool-contract.md`](docs/tool-contract.md) 和 [`docs/sandbox-policy.md`](docs/sandbox-policy.md)。

## 本机全权限 Control Agent

机主可以在本机开发站点中让 Agent 以当前 macOS 用户执行任意 Shell 命令：

```bash
npm run dev:control
```

该模式不是沙箱，也不会自动取得 root。它只在 loopback 站点可见，公网
`urtoris.cn` 不会暴露这些路由。运行方式、审计位置和风险边界见
[`services/local-control/README.md`](services/local-control/README.md) 与
[`docs/ADR-003-local-full-control.md`](docs/ADR-003-local-full-control.md)。

## ECS 部署

阿里云 ECS 所需的 Nginx、systemd 和安装脚本位于 [`deploy/`](deploy/README.md)。
