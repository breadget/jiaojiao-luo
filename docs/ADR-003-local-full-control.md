# ADR-003：本机网页 Control Agent 的全权限 Shell 边界

状态：已采纳  
日期：2026-09-15

## 决定

Urtoris 增加一个需要用户主动选择的「本机全权限」工作模式。Agent 可以通过
`run_shell` 在当前 Mac 上执行任意 `/bin/zsh -lc` 命令，权限等于启动服务的
macOS 用户。不做命令白名单，不放在 Python 沙箱中。

这个「全权限」有三条硬边界：

1. **只有本机页面**：站点路由要求 loopback / 可信本机同源请求。非本机主机名或代理链里带公网地址
   按不存在处理（404），跨站来源与来源不匹配按拒绝处理（403）；两者都不进执行器。
2. **只是当前用户**：不自动取得 root，不收集 sudo 密码，也不绕过 macOS 的访问辅助、完全磁盘访问等系统权限。
3. **不做线上回连**：`urtoris.cn` 不能调用这台 Mac；不建节点注册、反向隧道或远程任务下发。

本机开发服务器另有一层 Vite host 校验，伪造 `Host: urtoris.cn` 时会在到达站点代码前就被挡下（403），
所以线上真正生效的是上面这条站点门禁；两者的区别在
[`tests/local-control-access.test.ts`](../../tests/local-control-access.test.ts) 里按 403 / 404 分别断言。

## 调用链

```text
本机浏览器
  └─ 同源 /api/local-control/*
      └─ 站点服务端（再验证本机请求）
          └─ Authorization: Bearer <LOCAL_CONTROL_TOKEN>
              └─ 127.0.0.1:3020
                  └─ /bin/zsh -lc <command>（当前用户）
```

浏览器永远拿不到 `LOCAL_CONTROL_TOKEN`。它由本机启动脚本独立生成，只保存在
Git 忽略的 `work/local-control/control.env`，文件权限为 `0600`。Control Agent
只监听 `127.0.0.1:3020`，并拒绝配成非 loopback 地址。

## 执行与取消语义

- `POST /v1/runs` 持久化后立刻返回 `run_id` 与 `queued | running`，不等待命令结束。
- `GET /v1/runs/:run_id` 按 `task_id` 分区轮询，跨任务查询按不存在处理。
- 并发上限为 1，队列有显式上限；单条命令默认 1 小时，最长 24 小时。
- 取消排队任务会直接定稿为 `cancelled`；取消运行中任务会先向整个进程组发
  `SIGTERM`，3 秒后仍未退出则发 `SIGKILL`。
- 服务重启时，留下的 `queued/running` 会被如实定稿为
  `failed/NODE_RESTARTED`，不会补写成功。
- 终态只在运行文件和审计行都持久化后才对轮询者可见。

### 事件、落盘与并发位

`error` / `exit` / `close` 是**一次性**事件：只要挂监听器之前先 `await` 一次，就会
永久错过它们。实际做法：

- 子进程的所有监听器和超时定时器都在 `spawn` 之后的第一个 `await` 之前挂好。否则一条
  `printf ready`（约 10 毫秒）可能比两次落盘更快结束，运行会永远停在 `running`，
  并占住唯一的并发位直到服务重启。
- 同一次运行的 `submitted` / `started` / `finished` 三次落盘串行执行，所以更早的
  `running` 快照永远不会覆盖终态。
- 命令退出即停掉超时计时器；输出管道如果被它留下的后台进程继续持有，最多再等
  2 秒就按退出码定稿，不会把并发位一直吊到命令超时。

回归用例见 [`tests/local-control-executor.test.ts`](../../tests/local-control-executor.test.ts)
（`SlowStorage` 把落盘拖慢到命令之后，以及 `sleep 5 &` 占住管道两例）。

## 证据与审计

每个运行的完整状态和输出保存在 `work/local-control/state/runs/`；
`work/local-control/state/audit.jsonl` 按行记录提交、开始、取消请求和终态。
页面只在会话中保留截断后的命令、理由、状态、输出和 `run_id`，避免 D1 记录被大输出撑爆。

## 启动与停止

```bash
npm run dev:control
```

这条命令同时启动本机站点和 Control Agent。用 `Ctrl-C` 退出时，脚本会删除临时
`.dev.vars.urtoris-control-runtime`，并停止由本次命令启动的 Control Agent。单独管理服务时：

```bash
npm run control:local -- status
npm run control:local -- audit
npm run control:local -- stop
```

## 后果

这个模式能做当前用户在终端里能做的事，因此也可以读取该用户能读的凭据、
改写文件和调用已登录 CLI。这是有意的产品能力，不是沙箱。因此 UI 必须始终显示
真实用户、uid、主机、Shell 和默认目录，每条命令都要能展开查看。

任何公网开放、多用户使用、远程节点或 root 权限需求都是一个新的安全架构项目，
不能通过改一个环境变量延伸本 ADR。
