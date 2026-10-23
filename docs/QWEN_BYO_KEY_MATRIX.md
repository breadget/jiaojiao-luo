# Qwen / BYO Key 验收矩阵

本矩阵只针对克隆或本机环境，不需要也不得修改生产配置。

## 自动化覆盖

`tests/agent-chat-byo-key.test.ts` 使用内存 SQLite 和本机 OpenAI 兼容服务替身，覆盖：

| 路径                 | 预期                                                                       |
| -------------------- | -------------------------------------------------------------------------- |
| n8n 无 Key           | `mode=n8n`、`executionMode=rules`、`degraded=true`，信封不含 `context.llm` |
| 未绑定 n8n 且无 Key  | `mode=simulated`、`executionMode=simulated`、`degraded=true`               |
| 正确的模拟 Key       | 请求 `/chat/completions`，成功与 run 均为 `llm`、`degraded=false`          |
| 错误 Key             | HTTP 502 + `LLM_ERROR`，失败 run，不降级伪装成功                           |
| 断网                 | HTTP 502 + `NETWORK_ERROR`，失败 run                                       |
| 2xx 但响应非 JSON    | HTTP 502 + `LLM_ERROR`，失败 run                                           |
| 并发相同 `requestId` | 只调用一次上游，另一请求重放同一 run                                       |
| 会话隔离             | 不同 request 分别落入对应 session；跨 session 复用 request 返回 409        |

普通回归不访问外网，也不需要真实 Key：

```powershell
node --experimental-test-module-mocks --import tsx --import ./tests/helpers/loader-hooks.mjs --test tests/agent-chat-byo-key.test.ts
```

## 一次性真实 Key 验收

真实路径默认跳过。只有显式提供 `URTORIS_TEST_QWEN_API_KEY` 时，测试才会访问 Qwen 兼容端点。Key 不得写入命令行、文件、`.env` 或提交记录；运行后立即从当前进程环境删除。

```powershell
$env:URTORIS_TEST_QWEN_API_KEY = Read-Host -MaskInput '请输入一次性 Qwen Key'
try {
  node --experimental-test-module-mocks --import tsx --import ./tests/helpers/loader-hooks.mjs --test tests/agent-chat-byo-key.test.ts
} finally {
  Remove-Item Env:URTORIS_TEST_QWEN_API_KEY -ErrorAction SilentlyContinue
}
```

可选覆盖：`URTORIS_TEST_QWEN_BASE_URL` 和 `URTORIS_TEST_QWEN_MODEL`；缺省值分别是百炼 OpenAI 兼容端点和 `qwen-plus`。

通过条件：接口返回 200，`mode=model`、`executionMode=llm`、`degraded=false`，run 为 `completed / llm / degraded=false`，且本地运行记录中不包含 Key。真实提示和回复可能被上游保存，因此只允许一次性 Key 和无敏感测试文本。
