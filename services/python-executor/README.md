# Python Executor（pre-Agent）

这是 `run_python` MVP 的独立执行服务。它只监听 loopback，通过内部 Bearer token 接受上传、运行、查询和产物下载请求；网站的 `/api/python/*` 路由负责现有同源/API-token 门禁并转发到这里。

当前阶段只用于本地或隔离预生产验收，不连接 LLM、不连接 n8n，也不允许在 Docker 不可用时退回宿主机 Python。完成 [`sandbox-policy.md`](../../docs/sandbox-policy.md) 的十一项真实容器门禁前，不应部署到生产或开放给 Agent。

## 组成

- `protocol.ts`：严格的 `urtoris.python-executor.v1` 请求与结果类型。
- `server.ts`：loopback-only 内部 HTTP 服务和串行有界队列。
- `executor.ts`：幂等、每任务三次上限、状态迁移和审计。
- `docker-runner.ts`：无 Shell 的 Docker CLI 调用、硬超时、资源策略核验和容器清理。
- `artifacts.ts`：CSV/JSON/TXT/XLSX/DOCX/PPTX/PNG/PDF 的全有或全无回收；二进制产物都会在第二个一次性容器里完整校验。
- `Dockerfile`：固定 Python 3.12 运行时，预装数据、PDF 生成/解析、Word、PowerPoint、Excel 与 OpenDocument 库；旧版 Office 由 antiword / catppt / xls2csv 只读提取。运行镜像移除 shell、pip 和包管理器。

## 本地启动（macOS + Colima）

需要 Docker CLI、Buildx 和 Colima。一键入口会在需要时启动 4 CPU / 4 GiB 的 Colima，构建镜像，生成两份不复用的本机密钥，并把队列上限设为 1：

```bash
npm run executor:local -- start
```

密钥文件在已忽略的 `work/python-executor-local/executor.env`，权限为 `0600`。站点与 canary 启动前只把它加载到当前 shell：

```bash
set -a; source work/python-executor-local/executor.env; set +a
npm run executor:canary
npm run dev
```

使用端首次启用持久化时，若本地 D1 目录是旧的开发数据，还需要补应用端迁移：

```bash
npx wrangler d1 execute site-creator-d1 --local \
  --config wrangler.local.jsonc \
  --file drizzle/0010_consumer_sessions.sql
```

一百万行 CSV 分组汇总 + 出图的分钟级 long 档门禁，以及真实运行中取消门禁：

```bash
set -a; source work/python-executor-local/executor.env; set +a
npm run executor:gate:long
```

`npm run executor:local -- status|stop|restart` 可查看或管理服务；`stop` 不会停止 Colima VM。

在隔离 Linux Docker 主机运行十一项真实门禁：

```bash
PYTHON_EXECUTOR_IMAGE=urtoris/python-executor:dev \
npm run executor:test:docker
```

该开关会实际运行死循环、内存耗尽和网络探测，只能在专用测试主机使用。正式镜像验收时应把 image 换成 registry digest，并以 `NODE_ENV=production` 启动服务再次验证 seccomp、LSM 和 digest 门禁。

网站需要在忽略提交的 `.dev.vars` 中配置：

```text
PYTHON_EXECUTOR_URL=http://127.0.0.1:3010
PYTHON_EXECUTOR_TOKEN=<独立的 32 字符以上随机值>
PYTHON_TASK_SIGNING_KEY=<另一份独立的 32 字符以上随机值>
PYTHON_AGENT_ENABLED=1
```

不要在三者之间复用密钥，也不要复用 `URTORIS_API_TOKEN`、管理员 token 或 n8n token。`PYTHON_AGENT_ENABLED` 决定是否把 `run_python` 授予 Agent，默认关闭；只有本机/目标环境的十一项真实容器门禁全部通过后才应打开。

经网站调用时，先 `POST /api/python/tasks` 取得七天有效、只绑定一个 task ID 的 capability，并在后续上传、运行、查询和下载请求中发送 `X-Urtoris-Task-Token`；该 token 不会转发到 Executor 或容器。

## Agent 入口

`POST /api/python/agent` 是 Orchestrator：它按 [`docs/python-agent-system-prompt.md`](../../docs/python-agent-system-prompt.md) 组装系统提示词，把 `run_python` 作为 function tool 下发给模型（当前只支持 OpenAI 兼容协议的服务商），并在服务端强制每任务三次上限、幂等键一致性、`attempt` 顺序和文件授权。请求体：

```json
{
  "taskId": "task_...",
  "message": "用户任务文本",
  "inputs": [
    {
      "fileId": "file_...",
      "mountName": "sales.csv",
      "displayName": "销售数据.csv",
      "sizeBytes": 4096
    }
  ],
  "provider": "qwen",
  "apiKey": "用户自带的 Key"
}
```

响应包含 `reply`、每次尝试的终态/错误码/产物、`stopReason` 和 `replySource`。`replySource` 为 `guard` 时表示模型叙述与结构化结果冲突（例如把失败说成成功），网页展示的是被替换过的确定性结论；`runs[].artifactIds` 用于拼接受鉴权的下载入口。

## 内部接口

- `POST /v1/files`：原始 UTF-8 文件 body；请求头带 `X-Urtoris-Task-Id` 和 `X-Urtoris-File-Name`。
- `POST /v1/runs`：持久化 `run_python` v1 JSON 后立即返回 `202 + run_id + queued`。
- `GET /v1/runs`：按 task ID 列出运行。
- `GET /v1/runs/:run_id`：读取中间或最终状态，请求头带 task ID。
- `DELETE /v1/runs/:run_id`：取消排队或运行中的任务；定稿为 `killed/CANCELLED`。
- `GET /v1/artifacts/:artifact_id`：下载成功产物，请求头带 task ID 和 run ID。

除 loopback `/health` 外，所有接口都要求独立内部 Bearer token。服务启动时会先取得存储锁、清理带专用 label 的上次残留容器，再把中断的 `queued/running` 记录定稿为 `failed/WORKER_ERROR`。

## 当前明确限制

- 队列是单进程串行队列；不支持横向扩容或多 Worker 抢租约。
- 文件和运行记录使用 Worker 私有本地目录；对象存储后端尚未接入。
- CPU time 仍可能为 `null`；峰值内存由 Worker 每 500 ms 调用 `docker stats` 采样，极短任务可记为 0，OOM 则至少记录档位上限。
- macOS/Colima 没有 AppArmor/SELinux，本地节点隔离弱于生产 Linux 节点，只处理机主自己的数据。本机已实测 11 项真实容器门禁、68.169 秒 long 任务，以及真实容器运行中的执行器进程强制中断/重启和残留清理；物理合盖/休眠仍未冒充实测。证据见 [`docs/evidence/python-executor-local-gates.json`](../../docs/evidence/python-executor-local-gates.json) 与 [`docs/evidence/python-executor-long-run.json`](../../docs/evidence/python-executor-long-run.json)。

## 本机与线上的差异

| 项目 | 本机 Colima | 线上 Linux Executor |
| --- | --- | --- |
| 调用关系 | 本机站点 → loopback Executor | 站点主机 → loopback systemd 服务 |
| 用途 | 仅机主自己的数据 | 按生产账号和节点边界运行 |
| LSM | 无 AppArmor/SELinux，`requireLsm=false` | 必须实测 AppArmor/SELinux，fail closed |
| 镜像 | 本地 dev tag | 必须按 sha256 digest/ID 固定 |
| 生命周期 | 受 macOS 休眠/合盖影响 | systemd 监督，独立节点常驻 |
| 连接 | 不注册、不建隧道、不接线上站点 | 只使用部署主机内部地址 |
