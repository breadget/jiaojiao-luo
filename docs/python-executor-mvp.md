# Python Executor MVP

状态：已实现；short/long 档位已通过真实容器门禁
版本：v1  
日期：2026-09-15

相关规格：[工具协议](tool-contract.md) · [沙箱策略](sandbox-policy.md)

## 1. 目标

第一版只验证一个闭环：Agent 为当前任务生成 Python，执行器在隔离环境中运行一次，返回可核验的日志、终态和结果文件；Orchestrator 根据结构化失败结果决定是否修改代码并重试。

完成标准不是“代码已提交”，而是固定测试覆盖普通执行、失败、资源限制、隔离、产物回收和清理，并且网页不会把失败显示成成功。

## 2. MVP 范围

### 支持

- 运行单个 Python 入口文件 `main.py`。
- Python 3.12.x；镜像按 digest 固定。
- 标准库，以及镜像内预装并固定版本的数据、PDF、Word、PowerPoint、Excel 和 OpenDocument 解析库；旧版 Office 使用固定的只读提取工具。
- 用户上传 UTF-8 / UTF-8 BOM 的 CSV、JSON、TXT 文件，PDF，Word、PowerPoint、Excel、OpenDocument 文档和 PNG / JPEG 图片；二进制输入按魔数校验，真正的解析在沙箱内完成。
- 通过受控 `file_id` 把本任务输入映射到 `input/<name>`；不接受宿主机路径。
- 捕获 `stdout`、`stderr`、退出码、状态、耗时和资源峰值。
- 从 `output/` 回收 CSV、JSON、TXT、XLSX、PNG 结果文件。
- 保存每次尝试的源代码、日志、元数据和已验证产物。
- Agent 因可修复的代码错误最多自动修改两次，即单个任务最多执行三次。

### 不支持

- `run_shell(command)` 或其他任意 Shell 工具。
- 运行时安装包、修改镜像或上传自定义依赖。
- 互联网、局域网、云元数据服务或其他网络访问。
- 读取宿主机、本任务以外的文件或其他用户的文件。
- 后台服务、守护进程、交互式程序和超过 long 档 10 分钟上限的任务。
- 并发多 Agent、并行 Python 尝试或同一任务的竞态执行。
- Browser / Computer Control、ROS2、仿真或真实机器人控制。
- 把 n8n 当作代码沙箱。

“不支持 Shell”表示产品不暴露 Shell 工具，也不在运行镜像中提供 shell、包管理器、编译器和网络工具。Python 本身仍按不可信代码处理；安全性依靠操作系统级隔离，不依靠提示词、导入黑名单或静态代码扫描。

## 3. 固定运行模型

每次调用只执行一次，不在 Executor 内部偷偷重试：

```text
用户任务
  → Orchestrator 生成一次代码
  → run_python 创建一个 run
  → Queue / Sandbox Worker 执行一次
  → 返回结构化结果
  → Orchestrator 总结，或生成下一次尝试
```

容器内的约定目录为：

```text
/workspace/main.py          只读入口
/workspace/input/           只读输入
/workspace/output/          唯一可回收的结果目录
/tmp                        有大小上限的临时目录
```

进程工作目录是 `/workspace`。代码应使用相对路径 `input/<name>` 和 `output/<name>`；写到其他位置的内容不会成为产物。

## 4. 默认限额

| 项目 | MVP 限额 |
| --- | ---: |
| 代码 | 64 KiB |
| 输入文件 | 最多 10 个；单个 25 MiB；合计 50 MiB |
| 墙钟时间 | `short` 最大 30 秒；`long` 最大 600 秒 |
| CPU | `short` 1 vCPU；`long` 2 vCPU |
| 内存 | `short` 512 MiB；`long` 2 GiB；不使用额外 swap |
| 进程数 | 64 |
| `stdout` | 保留前 1 MiB，超出部分丢弃并标记截断 |
| `stderr` | 保留前 1 MiB，超出部分丢弃并标记截断 |
| 结果文件 | 最多 20 个；单个 50 MiB；合计 100 MiB |
| PNG | 单张最多 50 megapixels |

限额由服务端策略决定。Agent 必须显式选择 `profile`，可以申请比该档更短的超时，不能要求放宽上限。本轮不提供 30 分钟档。

## 5. 输入与产物规则

- 上传完成后由业务 API 返回不透明 `file_id`；`file_id` 必须归属当前用户和 `task_id`。
- 在正式账号体系接入前，业务 API 为每个随机 `task_id` 签发七天有效的 HMAC capability；上传、运行、查询和下载都必须同时验证它。该 capability 不发送给 Executor 容器，也不能代替内部服务 token。
- 映射名必须匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`，是带允许后缀的单层文件名，不能含路径分隔符、`..` 路径段或控制字符；同一次运行内不得重名。原始展示名可另外保存，不用于挂载。
- 不接受目录、压缩包、符号链接、设备、FIFO 或 socket。
- Executor 只发布 `output/` 的直接子文件；文件名使用与 `mount_name` 相同的安全格式，后缀限 CSV、JSON、TXT、XLSX、PNG。回收时重新校验规范路径、扩展名、MIME、大小和文件签名。
- JSON 产物必须是有效 JSON；PNG 必须可安全解码；XLSX 必须能被 openpyxl 完整解析且不含宏；HTML、SVG、可执行文件和未知类型一律拒绝。
- 失败、超时或被终止的运行不发布半成品；其日志和元数据仍保存用于诊断。
- 产物使用新的不透明 `artifact_id` 下载，不返回存储路径或容器路径。

## 6. 重试与停止条件

重试属于 Orchestrator，不属于 Executor：

- 一个 `task_id` 最多三个 Agent 代码尝试，每次有不同 `run_id`，并保留父子关系。
- 只有明确的 Python 代码或产物错误（如 `SyntaxError`、未捕获异常、数据解析错误、`ARTIFACT_REJECTED`）可以触发自动修复。
- 对 `stderr` 最末异常类型、归一化消息和错误码生成 `error_fingerprint`；连续两次指纹相同立即停止。
- `timed_out`、内存/进程限制、策略违规、人工取消和 Worker 隔离故障在 MVP 中不自动重试。
- Agent 的下一次代码必须基于上一次真实结构化结果，不能假定缺失的输出。
- 最终回答必须说明共执行几次、最后状态、主要错误以及实际发布的产物；没有成功就必须明确说未成功。

## 7. 可追溯记录

以下是对象存储中的逻辑键结构，不是提供给 Agent 的宿主机目录：

```text
task_id/
├── input/<file_id>/<safe_name>
├── runs/<run_id>/source/main.py
├── runs/<run_id>/logs/stdout.txt
├── runs/<run_id>/logs/stderr.txt
├── runs/<run_id>/artifacts/<artifact_id>/<safe_name>
└── runs/<run_id>/metadata.json
```

`metadata.json` 至少记录协议版本、代码哈希、输入/产物哈希、镜像 digest、有效资源限制、状态迁移、退出原因、截断标记、时间戳和清理结果。默认保存源代码/文件/日志/产物 7 天，审计元数据 30 天；用户提前删除任务时同步删除其可删除数据。

网页至少展示本任务每次尝试的代码、状态变化、`stdout` / `stderr`、退出码、自动修改次数、耗时、CPU、峰值内存、产物预览（适用时）和鉴权下载入口。中间尝试与失败记录不能被最终成功覆盖或隐藏。

## 8. 验收门槛

接入 LLM 前，下列测试必须全部通过且留下运行记录：

1. 普通 Python 返回正确输出和退出码 0。
2. 语法错误返回 `failed`、非零退出码和真实 `stderr`。
3. 死循环在 30 秒内进入 `timed_out`。
4. 内存耗尽被终止并返回可区分的资源错误。
5. DNS、HTTP、私网地址和云元数据访问均失败。
6. 预置在宿主机的标记文件、宿主任务目录和其他任务输入均不可读；容器内自己的最小只读运行文件不视为宿主泄漏。
7. 超大 `stdout` / `stderr` 被截断，Worker 不因背压失控。
8. 合法 CSV、PNG 被校验、存储并可按权限下载；危险产物被拒绝。
9. 容器、临时卷和运行凭据在终态后被清理；清理失败会告警并隔离 Worker。

上述门槛通过后，才允许 Orchestrator 调用 `run_python`；它不解锁 n8n 任意代码节点、Shell、浏览器或机器人能力。

后续扩展必须依次重新评审：受限 Shell 只能从 `list_files`、`read_git_status`、`run_tests`、`start_approved_script` 等明确动作开始，不能直接开放 `run_shell(command)`；Browser、Computer、ROS2 Simulation 和真实 Robot Control 使用各自的新工具协议。真机控制还必须具备人工确认、指令/速度/空间限制、dead-man timeout、紧急停止和完整审计，且先通过仿真。
