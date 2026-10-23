# ADR-002：本机站点与本机执行器的最小握手

状态：已采纳
日期：2026-09-15

## 决定

本阶段只支持「本机站点 ↔ 本机 Python Executor」，不让线上
`urtoris.cn` 回连用户电脑，不实现节点注册、公网隧道、NAT 穿透或任务下发。

握手只有两层：

1. 浏览器只请求同源站点的 `/api/python/*`，使用 HttpOnly 匿名会话或短期 task capability；浏览器永远不拿 Executor 服务密钥。
2. 站点服务端只连 `http://127.0.0.1:3010`，并在每次请求中带独立的 `Authorization: Bearer <PYTHON_EXECUTOR_TOKEN>`。Executor 只监听 loopback，并再用 `X-Urtoris-Task-Id` 分区。

`PYTHON_EXECUTOR_TOKEN` 与 `PYTHON_TASK_SIGNING_KEY` 由本机脚本分别生成，只保存在权限为 `0600` 且已被 Git 忽略的 `work/python-executor-local/executor.env`；不复用站点 Admin/API/n8n 密钥。

## 运行边界

- macOS 使用 Colima/Lima，VM 配置 4 vCPU / 4 GiB；执行队列上限为 1。
- `short` 档是 30 秒 / 512 MiB / 1 vCPU；`long` 档是 10 分钟 / 2 GiB / 2 vCPU。本轮不留 30 分钟档。
- 代码仍只在一次性 Docker 容器内运行：无网络、只读根文件系统、非 root、丢弃全部 capability，且每次终态后验证清理。
- Colima 可提供 Docker 默认 seccomp，但没有生产 Linux 节点要求的 AppArmor/SELinux。因此本地节点只处理机主自己的数据，不当作多租户安全边界。
- macOS 休眠/合盖可暂停或中断 Colima。执行器重启时把持久化的 `queued/running` 定稿为 `failed/WORKER_ERROR`；网页恢复后必须如实显示，不会补写成功。

## 为什么现在不接线上

线上调用本机会新增设备身份、密钥轮换、心跳/租约、反向隧道、任务归属、离线恢复、远程取消和更强的宿主隔离。这些不是「最小握手」的延伸，需要独立威胁模型与协议评审。

## 运行方式

```bash
npm run executor:local -- start
set -a; source work/python-executor-local/executor.env; set +a
npm run dev
```

脚本会检查 Docker/Buildx，必要时启动 Colima，构建镜像，生成本机密钥并启动 loopback Executor。本机与线上的具体差异见 [`services/python-executor/README.md`](../services/python-executor/README.md)。
