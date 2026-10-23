# Local Control Agent

这是 Urtoris 的**本机、当前用户、非沙箱** Shell 执行服务。它只适合机主在自己的
Mac 上使用，不是多租户或公网执行器。完整决策见
[`docs/ADR-003-local-full-control.md`](../../docs/ADR-003-local-full-control.md)。

## 一键启动

```bash
npm run dev:control
```

这条命令要求 3000 端口是空的：站点必须**带着** Control Agent 的运行时配置启动，
否则网页拿不到控制权。如果已经有 `npm run dev` 在跑，脚本会在启动任何东西之前
直接拒绝，并打印占用端口的进程号。

打开 `http://localhost:3000`，进入「使用工作流端」：

1. 在「设置 · 模型与本机」里配置一个支持 OpenAI 兼容 tool calls 的模型。
   Ollama 可以留空 Key；其他服务按页面要求填写。
2. 点输入框左边的加号，将「工作模式」切到「本机全权限」。
3. 直接描述任务。每条 Shell 命令的状态、耗时、输出和 `run_id` 都会显示在对话记录里。

关闭开发服务器时，本次脚本启动的 Control Agent 也会停止。

## 独立管理

```bash
npm run control:local -- start
npm run control:local -- status
npm run control:local -- audit
npm run control:local -- restart
npm run control:local -- stop
```

本地私有状态在 `work/local-control/`：

- `control.env`：站点↔执行器的独立 token，`0600`。
- `control.log`：服务运行日志。
- `state/runs/*.json`：每个运行的完整观测。
- `state/audit.jsonl`：追加式命令审计，`0600`。

这些路径都已被 Git 忽略，不要复制到公共 issue 或提交里。

## 边界

- 命令是任意 zsh，可使用管道、重定向、已安装 CLI 和网络。
- 默认目录是仓库根，Agent 也可传入其他绝对路径。
- 权限等于启动服务的 macOS 用户；不会自动获得 root。
- macOS 的访问辅助、完全磁盘访问、摄像头等系统权限仍然生效，本服务不会绕过它们。
- 只监听 loopback，站点路由也只对本机同源请求开放。不要在 nginx、隧道或路由器上转发 3020 端口。

## 验证

```bash
npm test                            # 单元与 HTTP 契约；含上面提到的两个竞态回归
npm run control:local -- start
npm run control:gate                # 打真实服务：身份、快命令、失败、取消、超时、幂等、审计
```

`npm run control:gate` 需要服务正在运行，结果写到
[`docs/evidence/local-control-review.json`](../../docs/evidence/local-control-review.json)：
9 项门禁全部真实执行，命令以当前 macOS 用户身份跑在 `/bin/zsh` 里。

## 没有模型 Key 时跑通网页全链路

```bash
npm run control:stub-model      # 127.0.0.1:3021 的 OpenAI 兼容确定性替身
npm run dev:control
```

在页面上把模型服务选成「自定义（OpenAI 兼容）」，Base URL 填
`http://127.0.0.1:3021/v1`，模型名随便填。替身第一轮返回一个 `run_shell` 工具调用、
第二轮把工具结果念回来，用来验证「浏览器 → 站点 Agent → 本机 Control Agent → zsh」
整条链路。它**不代表**真实模型能力：支持 tool calls 的真实模型必须另外用一次性 Key 复核。
