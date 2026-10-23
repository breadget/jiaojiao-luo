# Computer Control Server · Day 1

这是一个默认只监听本机的结构化动作执行服务。外部调用方只能提交已注册的
`action + params`；服务不提供任意 Shell、cmd 或 PowerShell 入口。

Day 1 的白名单只有一个只读动作：`python_version`。

## 环境与启动

要求 Python 3.10 或更高版本。

Windows PowerShell：

```powershell
cd D:\deepseek\computer-agent
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python app.py
```

macOS / Linux 开发验证：

```bash
cd computer-agent
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python app.py
```

正式入口固定为 `http://127.0.0.1:8765`。不要在没有鉴权的情况下把监听地址改成
`0.0.0.0`。Swagger 文档由 FastAPI 自动提供在 `/docs`。

## 接口

### `GET /health`

```json
{
  "status": "online",
  "version": "0.1.0",
  "platform": "Windows-10-10.0.22631-SP0",
  "python": "3.11.9",
  "started_at": "2026-09-12T19:22:31.000+08:00"
}
```

### `GET /capabilities`

返回完整的机器可读白名单，包括参数 JSON Schema、权限等级、超时和副作用。AI 或
其他编排器未来只能从这份契约选择动作，不能自行编造命令。

### `POST /action`

请求只接受三个字段，多余字段会在协议层被拒绝：

```json
{
  "requestId": "req_893124",
  "action": "python_version",
  "params": {}
}
```

`requestId` 可省略。合法值必须匹配 `^req_[A-Za-z0-9]{1,32}$`，合法值原样透传；
缺省时生成 `req_` 加 6 位随机字符；非法值按缺省处理，并在审计日志中写入
`invalid_request_id: true`。

成功响应：

```json
{
  "requestId": "req_893124",
  "action": "python_version",
  "success": true,
  "data": {
    "output": "Python 3.11.9",
    "version": "3.11.9",
    "implementation": "CPython",
    "executable": "C:\\Python311\\python.exe"
  },
  "message": "",
  "error": null,
  "duration_ms": 1,
  "timestamp": "2026-09-12T19:22:31.000+08:00"
}
```

## Day 1 白名单

| action | level | 参数 | 超时 | 副作用 |
| --- | ---: | --- | ---: | --- |
| `python_version` | 0 · READ_ONLY | 无 | 5 秒 | `none` |

白名单写死在代码注册表中。不能从请求、配置或数据库动态注册，也不提供运行时移除接口。

## 错误码与 HTTP 状态

| code | 含义 | HTTP |
| --- | --- | ---: |
| `UNKNOWN_ACTION` | 动作不在白名单 | 200 |
| `INVALID_PARAMS` | 动作参数不符合契约或含危险片段 | 200 |
| `PERMISSION_DENIED` | 当前权限不足 | 200 |
| `FORBIDDEN_ACTION` | 绝对禁止的动作 | 200 |
| `TIMEOUT` | 超过动作声明的超时 | 200 |
| `EXEC_FAILED` | 已批准的内部进程执行失败 | 200 |
| `NOT_FOUND` | 已批准的目标不存在 | 200 |
| `INTERNAL_ERROR` | 未预期的服务端异常 | 500 |

业务失败仍返回 HTTP 200，并通过 `success: false` 与 `error.code` 分流。这样未知动作等
可预期业务结果不会被编排器误当作工作流系统故障。非法 JSON、缺少 `action`、请求多余
字段等协议错误返回 422；未捕获异常返回 500。所有响应均使用同一标准 JSON 外壳，且
500 响应不包含 traceback。

## curl 示例

正常调用：

```powershell
curl.exe -X POST http://127.0.0.1:8765/action `
  -H "Content-Type: application/json" `
  -d "{\"action\":\"python_version\"}"
```

未知动作：

```powershell
curl.exe -X POST http://127.0.0.1:8765/action `
  -H "Content-Type: application/json" `
  -d "{\"action\":\"run_command\",\"params\":{\"cmd\":\"whoami\"}}"
```

非法参数：

```powershell
curl.exe -X POST http://127.0.0.1:8765/action `
  -H "Content-Type: application/json" `
  -d "{\"action\":\"python_version\",\"params\":{\"x\":1}}"
```

## 审计日志

每次动作请求，包括未知动作和参数拒绝，都会追加到
`logs/actions-YYYY-MM-DD.jsonl`。日志包含 requestId、动作、脱敏参数、权限等级、结果、
耗时、输出大小、来源 IP 和进程号。字段名含 `token`、`password`、`key` 或 `secret` 的值
递归替换为 `***`。日志写入失败只写 stderr，不改变动作结果；启动时会清理 30 天前的日志。

示例：

```json
{"ts":"2026-09-12T19:22:31.412+08:00","requestId":"req_893124","action":"python_version","params":{},"level":0,"status":"success","duration_ms":1,"output_size":13,"error":null,"source_ip":"127.0.0.1","pid":23184}
```

## 测试

```bash
cd computer-agent
. .venv/bin/activate
pytest -q
```

测试覆盖接口契约、白名单、权限、非法参数、requestId、协议层 422、内部 500、超时进程
清理、输出截断、非零退出、日志脱敏与日志故障降级。
