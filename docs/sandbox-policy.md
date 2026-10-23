# Python Sandbox Policy v1

状态：已实现；生产与本机边界分开验收
适用范围：Python Executor MVP  
日期：2026-09-15

相关规格：[MVP 边界](python-executor-mvp.md) · [工具协议](tool-contract.md)

## 1. 信任模型

Agent 生成的 Python、用户上传的文件、文件名、日志和产物都视为不可信。业务 API、n8n、提示词、模型判断、Python 导入限制和静态扫描都不构成安全边界。

MVP 的安全边界是独立 Sandbox Worker 启动的一次性容器，以及 Worker 所在主机的纵深隔离。n8n 可以编排可信工作流或调用业务 API，但不得直接执行 Agent 代码、挂载任务目录或充当 Sandbox Worker。

## 2. 架构与职责

```text
Web
  → Business API（身份、任务、上传与下载权限）
  → Agent Orchestrator（最多三次尝试、停止条件）
  → Tool Gateway（协议校验、幂等、配额）
  → Queue（有界排队、租约）
  → Sandbox Worker（准备目录、启动/监督/销毁）
  → Ephemeral Container（唯一代码执行位置）
  → Private Artifact Storage（校验后发布）
```

- Business API 不运行代码，也不把存储路径发给 Agent。
- Tool Gateway 必须在入队前完成授权、文件归属、次数、大小和协议校验。
- Worker 只接收运行所需的文件副本和短期、最小权限的存储能力；不接收用户长期凭据。
- Artifact Storage 默认私有，所有上传和下载都绑定授权主体、`task_id` 和 `run_id`。

## 3. 容器强制策略

每个 `run_id` 使用全新的容器和临时目录。最低策略如下：

| 控制项 | MVP 要求 |
| --- | --- |
| 身份 | 固定非 root UID/GID；不能切换用户。 |
| 镜像 | 最小 Python 3.12 镜像，按 digest 固定；无 shell、包管理器、编译器、SSH、curl/wget。 |
| 网络 | 容器网络关闭；Worker 主机额外拒绝执行网段到公网、私网和云元数据的出口。 |
| 根文件系统 | 只读。 |
| 挂载 | 只挂当前 run 的入口、输入和输出；入口/输入只读，输出读写（bind 挂载，容器固定 UID 可写），绝不挂父目录。结果目录不得用容器内 tmpfs：tmpfs 随容器停止一起消失，停机后再回收只会拿到空目录。bind 挂载不带 `noexec,nodev,nosuid`，因此承载结果目录的宿主卷必须以这三个选项挂载。 |
| 临时空间 | 独立 tmpfs，`nosuid,nodev,noexec`，最大 64 MiB。 |
| CPU | `short` 1 vCPU；`long` 2 vCPU；不能超过所选档位。 |
| 内存 | `short` 512 MiB；`long` 2 GiB；含容器内存且无额外 swap。 |
| 进程 | PID namespace 隔离，最多 64 个进程/线程。 |
| 打开文件 | `nofile` 软/硬限制均为 256。 |
| 输出空间 | 当前 run 的可写输出卷最大 128 MiB，由 Worker 在执行期间监视输出目录、超限立即终止并记为 `killed` / `POLICY_VIOLATION`；可发布产物仍受 100 MiB 总限额约束。 |
| 日志驱动 | 使用 `local` 驱动并显式设置 `compress=false`：Docker 29 在 `max-file=1` 时拒绝带压缩的 `local` 驱动，容器会直接创建失败。 |
| 权限 | 删除全部 Linux capabilities，启用 `no-new-privileges`。 |
| 系统调用 | 使用默认拒绝策略的 seccomp，并配合 AppArmor/SELinux；禁止 mount、ptrace、内核模块、原始设备等能力。 |
| 宿主资源 | 禁止 Docker/容器运行时 socket、宿主 PID/IPC/network namespace、设备和特权模式。 |
| 时间 | Worker 从容器启动计时；`short` 最多 30 秒，`long` 最多 600 秒；先终止，再在短宽限后强杀。 |
| 环境变量 | 只注入无秘密的固定运行变量；不注入 API key、数据库 URL、云凭据、宿主路径或用户令牌。 |

镜像中即使没有 Shell，也不能假定 Python 无法调用系统调用。因此不得用 AST/关键字黑名单作为放行条件；真正的限制必须由容器、内核策略、文件挂载和网络策略强制。

Worker 启动后必须核验 UID、只读根文件系统、cgroup 限额、capability 集合和 LSM/seccomp profile；发现未生效或处于 unconfined 状态时，在执行用户代码前 fail closed。

容器共享宿主内核，不能提供虚拟机级绝对隔离。Worker 应运行在不存放生产密钥和业务数据库的独立节点/账号上，保持内核与容器运行时补丁，并限制其到业务系统的入站和出站访问。gVisor、Kata 或 microVM 作为多租户强化项，不是本 MVP 解锁 Agent 的前置替代品。

### 本机 Colima 例外

本机单用户开发节点执行同样的容器参数与生效核验，但 macOS/Colima 没有 AppArmor/SELinux，因此允许 `requireLsm=false`。这个例外只适用机主本人数据，不解锁公网或多租户运行；生产模式仍必须按 digest 固定镜像并确认 LSM 实际生效。

## 4. 文件隔离与回收

### 输入

- Business API 先验证登录主体和 `task_id`，再把 `file_id` 解析为私有存储对象。
- Worker 接收字节副本，不接收用户给出的系统路径、URL、对象存储 key 或任意挂载参数。
- 只允许 UTF-8 文本/数据、PDF、Word、PowerPoint、Excel、OpenDocument 与 PNG / JPEG 图片；上传阶段文本类按 UTF-8 校验、二进制类按魔数校验，真实解析只发生在沙箱内。不解压任意归档，不跟随符号链接，不复用用户文件权限位。
- 映射名规范化后必须是单层唯一文件名；大小、数量和文本编码按 MVP 限额校验。
- 每次 run 的输入目录不可写，其他任务目录从未挂入容器。

### 输出

- 只有 `/workspace/output` 的直接子文件才进入回收流程；文件名必须匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`，且使用允许的产物后缀。
- 容器停止后，Worker 以不跟随链接的方式扫描；规范路径必须仍在本 run 的输出根目录内。
- 拒绝符号链接、硬链接逃逸、目录、socket、FIFO、设备、稀疏文件超限和检查时发生变化的文件。
- 只允许 CSV、JSON、TXT、XLSX、DOCX、PPTX、PNG 与 PDF，并同时检查扩展名、MIME/文件签名、单文件/总大小；PNG 还要检查像素上限，Office 产物要完整解析并拒绝宏、嵌入对象和外部链接，PDF 要用 pypdf 完整解析并拒绝加密、脚本、动作、外部链接和附件；所有二进制产物都在第二个一次性容器中校验。
- 文件先进入隔离区，校验、计算 SHA-256 并落元数据后再原子发布；产物发布全有或全无，任一候选不合法则整次运行返回 `failed/ARTIFACT_REJECTED` 且不发布文件。
- 下载使用 `Content-Disposition: attachment`、`X-Content-Type-Options: nosniff` 和正确 MIME；CSV/文本在网页预览时必须转义，不能当 HTML 执行。

## 5. 资源、日志与终止

- 墙钟、内存、PID、临时磁盘、输出目录和日志字节数都由 Worker/容器强制，不能只在 Python 内检查。
- `stdout` 与 `stderr` 分开持续读取，各保留前 1 MiB；超出后继续排空但丢弃，并记录原始已见字节数与截断标记。
- 网页显示前移除 ANSI 转义并转义控制字符；日志永远按纯文本处理。
- 达到墙钟限制返回 `timed_out/TIMEOUT`；确认 OOM 返回 `killed/MEMORY_LIMIT`；PID 上限返回 `killed/PROCESS_LIMIT`。
- 无法确认具体原因时返回保守的 `failed/WORKER_ERROR`，不能猜测成 Python 代码错误。
- 失败、超时或终止后不发布 `output/` 中的半成品。

## 6. 秘密、网络与跨任务访问

- 容器环境、命令行、文件和挂载中不得出现服务器密钥、n8n token、数据库凭据、云凭据或用户会话。
- Worker 使用独立服务身份；若必须上传结果，只获得绑定当前 `run_id`、短期有效、仅可写指定前缀的权限。
- `--network=none` 之外，Worker 节点的防火墙必须默认拒绝执行环境出口，尤其是 RFC1918、loopback 邻接服务、链路本地和 `169.254.169.254`。
- 队列消息不接受回调 URL。状态与结果由 Gateway/业务 API 读取，避免 SSRF 回调通道。
- 对象存储不使用公开 bucket；下载前每次重新检查主体与任务归属，短期签名 URL 不写入日志。

## 7. 生命周期与清理

```text
validate → stage → create → run → stop → collect → destroy → verify cleanup → publish terminal state
```

- 任一步失败都必须 fail closed：不扩大权限、不切换到宿主执行、不转交 n8n Code 节点。
- Worker 使用租约防止同一 run 被两个 Worker 同时执行；租约过期不等于允许重复副作用，Gateway 仍按幂等记录裁决。
- 进程终止后先销毁容器，再删除临时挂载和卷；不能只删除数据库记录。
- Worker 必须验证容器、网络 namespace、临时卷和运行目录已经消失，并把结果写入 `cleanup_status`。
- 清理失败时运行返回 `failed/WORKER_ERROR` 且不发布产物；保留真实进程退出码供审计。Worker 必须停止接新任务、隔离残留并告警；后台清理器重试，不能把残留留作“调试环境”。
- 源码、输入、日志和产物默认 7 天后删除；审计元数据默认保存 30 天。删除任务时按产品隐私规则提前清理。

## 8. 审计要求

每个 run 至少记录：

- 授权主体、`task_id`、`run_id`、attempt、幂等键哈希和父 `run_id`。
- 请求/响应协议版本、代码 SHA-256、输入与产物 SHA-256。
- 容器镜像 digest、Worker ID、实际生效的资源/安全策略版本。
- 排队、开始、终止、产物发布和清理时间。
- 每次状态迁移、真实退出码、错误码、资源峰值和日志截断信息。
- 产物拒绝原因、人工取消主体和清理结果。

审计日志追加写、访问受限，不保存 Authorization 头、签名 URL、API key 或不必要的用户文件内容。

## 9. 上线前安全测试

除功能测试外，至少自动验证：

1. 非 root、capabilities、只读根文件系统、seccomp/LSM 和 `no-new-privileges` 实际生效。
2. TCP/UDP/DNS、公网、私网、宿主网关和云元数据均不可达。
3. `/etc/shadow`、Docker socket、Worker 文件、相邻任务输入和对象存储凭据不可读。
4. `../`、绝对路径、Unicode/分隔符变体、符号链接、FIFO、设备和产物竞态被拒绝。
5. fork bomb、线程爆炸、内存爆炸、临时磁盘填满和超大输出被各自的限制终止。
6. 退出码、OOM、超时、取消和 Worker 故障不会被错误标成 `succeeded`。
7. 失败运行不发布半成品，越权 `artifact_id` 无法下载。
8. 终态后容器、临时卷、namespace 和目录确实清理；故意制造清理失败会隔离 Worker 并告警。
9. n8n、Business API 和 Orchestrator 主机上都不存在绕过 Worker 的 Agent 代码执行路径。

只有这些门禁通过并在隔离预生产环境完成回归后，才能让 LLM 获得 `run_python`。后续 Shell、Browser、Computer 或 Robot Executor 必须使用各自的新协议和策略评审，不能继承 Python 工具权限自动开放。
