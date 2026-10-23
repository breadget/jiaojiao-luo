# `run_python` 工具协议 v1

状态：已实现并通过本机真实容器门禁
协议标识：`urtoris.python-executor.v1`  
日期：2026-09-15

相关规格：[MVP 边界](python-executor-mvp.md) · [沙箱策略](sandbox-policy.md)

## 1. 边界与语义

`run_python` 是 Agent Orchestrator 到 Tool Gateway 的内部工具，不直接暴露给浏览器。调用是显式异步的：`POST /v1/runs` 持久化后立即返回 `202 + run_id + queued`，Orchestrator 用 `GET /v1/runs/:run_id` 轮询到终态。网页可通过业务 API 观察同一条 `queued/running` 记录。

每次工具调用只执行一次代码。自动修复和最多三次尝试由 Orchestrator 管理。

本协议独立于现有 `urtoris.v1` 工作流信封；后者可以引用 `task_id` / `run_id`，但不能把任意 n8n 节点变成 Sandbox Worker。

## 2. 请求

```json
{
  "protocol": "urtoris.python-executor.v1",
  "task_id": "task_123",
  "idempotency_key": "task_123:attempt:1",
  "attempt": 1,
  "code": "print(sum(range(1, 101)))",
  "input_files": [
    {
      "file_id": "file_abc",
      "mount_name": "data.csv"
    }
  ],
  "profile": "short",
  "timeout_seconds": 30
}
```

| 字段 | 规则 |
| --- | --- |
| `protocol` | 必须精确为 `urtoris.python-executor.v1`。 |
| `task_id` | 业务 API 已授权的任务 ID；不能由文件路径代替。 |
| `idempotency_key` | 同一逻辑尝试保持不变；长度 1–128。 |
| `attempt` | 1–3；服务端还要按 `task_id` 强制总次数，不能只信任该数字。 |
| `code` | UTF-8 Python 源码，最大 64 KiB；服务端保存哈希。 |
| `input_files` | 0–10 个受控文件引用；不接受 URL、路径或内联 base64。 |
| `file_id` | 不透明 ID，必须归属当前主体和 `task_id`，且处于可用期。 |
| `mount_name` | `input/` 下的单层唯一文件名；必须匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`。允许 UTF-8 文本/数据（`.csv`、`.json`、`.txt`）、PDF、Word（`.doc`、`.docx`、`.rtf`、`.odt`）、PowerPoint（`.ppt`、`.pptx`、`.odp`）、Excel（`.xls`、`.xlsx`、`.ods`）及图片（`.png`、`.jpg`、`.jpeg`），后缀大小写不敏感。 |
| `profile` | 必填；`short` 或 `long`。资源上限由服务端档位决定。 |
| `timeout_seconds` | 1–所选档位上限的整数；`short` 最大 30 秒，`long` 最大 600 秒，超限直接拒绝。 |

未知字段、重复 `mount_name`、失效/越权 `file_id`、路径穿越、代码超限或尝试次数超限必须在入队前拒绝。协议校验失败不会创建 `run_id`，也不消耗一次代码尝试。

## 3. 统一返回

```json
{
  "protocol": "urtoris.python-executor.v1",
  "task_id": "task_123",
  "run_id": "run_456",
  "attempt": 1,
  "parent_run_id": null,
  "profile": "short",
  "status": "succeeded",
  "exit_code": 0,
  "stdout": "5050\n",
  "stderr": "",
  "stdout_truncated": false,
  "stderr_truncated": false,
  "artifacts": [],
  "error": null,
  "metrics": {
    "queued_ms": 21,
    "duration_ms": 183,
    "cpu_time_ms": 37,
    "peak_memory_bytes": 18792448
  },
  "limits": {
    "timeout_seconds": 30,
    "cpu_count": 1,
    "memory_bytes": 536870912,
    "processes": 64,
    "stdout_bytes": 1048576,
    "stderr_bytes": 1048576
  },
  "created_at": "2026-09-14T10:00:00.000Z",
  "started_at": "2026-09-14T10:00:00.021Z",
  "finished_at": "2026-09-14T10:00:00.204Z",
  "cleanup_status": "succeeded"
}
```

所有已入队 run 使用同一结果结构。字段不能因成功或失败而换形；不可用值使用 `null`，不伪造为 `0` 或空字符串。入队前拒绝使用本节稍后定义的精简错误信封。

### HTTP 提交、查询与取消

- `POST /v1/runs`：首次合法提交在运行记录落盘后返回 `202`，带 `Location: /v1/runs/:run_id`；幂等重放返回同一 `run_id` 的当前或最终状态，不重复执行。
- `GET /v1/runs/:run_id`：返回当前快照。Orchestrator 只能在前一次尝试进入终态后提交下一次。
- `DELETE /v1/runs/:run_id`：`queued` 直接定稿为 `killed/CANCELLED`；`running` 先发出终止信号并返回 `202`，容器与临时目录确认清理后再定稿。终态重复取消是幂等读取。

### 状态

| 状态 | 含义 | 是否终态 |
| --- | --- | --- |
| `queued` | 已持久化并等待 Worker。 | 否 |
| `running` | Worker 已获得任务，沙箱开始执行。 | 否 |
| `succeeded` | 退出码为 0，产物校验和元数据落盘均完成。 | 是 |
| `failed` | Python 非零退出，或执行基础设施在安全终止后报告失败。 | 是 |
| `timed_out` | 达到墙钟上限并被 Worker 终止。 | 是 |
| `killed` | 因资源/策略限制、人工取消或 Worker 隔离被终止。 | 是 |

只允许：

```text
queued → running → succeeded | failed | timed_out | killed
queued → killed
```

终态不可回退。`succeeded` 必须同时满足退出码 0、日志已封存、全部产物通过扫描、容器清理已确认和元数据持久化；不能只因容器启动或 Python 退出成功就返回成功。

状态字段还必须满足：`succeeded` 时 `exit_code=0` 且 `error=null`；其他终态必须有非空 `error`；`queued` / `running` 的退出码和结束时间为 `null`；只有 `succeeded` 可以返回非空 `artifacts`。

`parent_run_id` 把自动修复尝试串成可审计链，第一次为 `null`。`cleanup_status` 为 `pending | succeeded | failed`；容器和临时目录都确认清理后才允许返回 `status=succeeded, cleanup_status=succeeded`。

### 退出码与错误

- `exit_code` 是 Python 进程的真实退出码。没有可靠退出码时为 `null`；不得用 124、137 等合成值冒充真实值。
- `error` 为 `null` 或以下稳定结构：

```json
{
  "code": "PROCESS_EXIT_NONZERO",
  "message": "Python process exited with a non-zero status.",
  "retryable": true,
  "error_fingerprint": "sha256:..."
}
```

MVP 稳定错误码包括：

| `error.code` | 对应状态 | 自动修复建议 |
| --- | --- | --- |
| `PROCESS_EXIT_NONZERO` | `failed` | 可，由 Orchestrator 分析真实 `stderr`。 |
| `WORKER_ERROR` | `failed` | 不可；交给平台告警。 |
| `TIMEOUT` | `timed_out` | MVP 不自动重试。 |
| `MEMORY_LIMIT` | `killed` | MVP 不自动重试。 |
| `PROCESS_LIMIT` | `killed` | MVP 不自动重试。 |
| `POLICY_VIOLATION` | `killed` | 不可。 |
| `CANCELLED` | `killed` | 不可。 |
| `ARTIFACT_REJECTED` | `failed` | 可修复；本次不发布任何产物。 |

请求校验和授权错误属于工具调用错误，不伪装成一次 Python 运行。它们使用独立但稳定的拒绝信封：

```json
{
  "protocol": "urtoris.python-executor.v1",
  "task_id": "task_123",
  "run_id": null,
  "status": null,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "The run request is invalid.",
    "retryable": false
  }
}
```

稳定的入队前错误码包括 `INVALID_REQUEST`、`UNAUTHORIZED`、`FILE_UNAVAILABLE`、`ATTEMPT_LIMIT`、`IDEMPOTENCY_CONFLICT` 和 `CAPACITY_EXCEEDED`。不存在与越权的文件都返回 `FILE_UNAVAILABLE`，避免泄露其他任务是否存在某个 `file_id`。入队前拒绝不创建 run，也不消耗代码尝试。

### 日志

- `stdout` / `stderr` 均为 UTF-8 字符串；无效字节使用替换字符，危险控制字符与 ANSI 转义在展示前转义或移除。
- 每个流最多保留前 1 MiB，并分别设置截断标记；两个流不能合并，否则会丢失诊断顺序与来源。
- 截断本身不改变进程退出状态。Worker 必须持续排空管道并丢弃超限内容，避免子进程因日志背压卡死。

### 产物

成功运行的每个已验证产物返回：

```json
{
  "artifact_id": "artifact_xyz",
  "name": "summary.csv",
  "mime_type": "text/csv",
  "size_bytes": 4821,
  "sha256": "sha256:..."
}
```

响应不包含宿主机路径、对象存储键或永久公开 URL。下载由业务 API 使用 `artifact_id` 再次鉴权，必要时生成短期签名地址。

产物发布采用全有或全无：任何候选文件不合法，运行返回 `failed/ARTIFACT_REJECTED`，本次不发布任何产物。其他失败、超时和被终止运行的 `artifacts` 也必须为空。

## 4. 幂等、并发与尝试次数

- 幂等范围是授权主体、`task_id` 和 `idempotency_key`。
- 相同 key 与相同规范化请求哈希再次到达时，返回原 `run_id` 和当前/最终记录，不重复执行。
- 相同 key 对应不同代码、输入、映射名或超时时，返回 `IDEMPOTENCY_CONFLICT`。
- 同一个 `task_id` 同时最多有一个 `queued` 或 `running` 的 Python run；MVP 不并行执行自动修复尝试。
- Orchestrator 必须等上一尝试到达终态，才可提交下一 `attempt`。
- 三次上限在服务端持久化计数；换 key、重放请求或伪造 `attempt` 不能绕过。

## 5. Agent 使用规则

Orchestrator 传给模型的工具说明必须明确：

- 只能读取请求中列出的 `input/<mount_name>`。
- 需要交付给用户的文件必须写入 `output/`。
- 不得声称没有出现在返回值中的输出、指标或产物已经生成。
- `failed` 时可以依据 `stderr` 修复；同一 `error_fingerprint` 连续出现两次必须停止。
- `timed_out`、`killed` 或 `retryable=false` 时停止自动执行并如实解释。
- 最终回答列出运行次数、最后 `run_id`、终态和产物名；敏感内部存储信息不进入回答。

## 6. 版本兼容

- v1 内只能新增可选字段或新的错误码；删除字段、改类型、改状态含义必须升级协议标识。
- 消费方必须忽略未知可选字段，但未知状态和未知协议必须 fail closed。
- 每条运行记录永久保存其协议版本和镜像 digest，以便复现和审计。
