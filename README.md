> **来源与贡献：** 本分支由 [@breadget](https://github.com/breadget) 导入和维护，包含协作或第三方成果；历史作者与许可见 [ATTRIBUTION.md](ATTRIBUTION.md)。新的提交记录表示导入与维护，不代表全部代码为个人独立原创。

# Urtoris

Urtoris 是一个工作流双端原型：

- **创建工作流端**：编辑、保存并发布多个工作流。
- **使用工作流端**：从已发布版本中装载一个工作流给 Agent，直接对话，查看执行过程和结果。

当前版本从首页选择身份进入对应工作台，暂不包含真实账号鉴权。

## 本地启动

```bash
npm ci
npm run dev
```

默认访问 `http://localhost:3000` 即可查看。

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

已发布工作流可通过 `POST /api/v1/run` 调用。请在服务器本地的 `.dev.vars` 中配置 `URTORIS_API_TOKEN`，不要将密钥提交到仓库。

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
