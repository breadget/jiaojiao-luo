# 能力契约

外部调用方只能执行本文件与代码注册表同时声明的结构化动作。AI 不等于 Shell：AI 只能
选择 `action` 并提供契约内参数，Control Server 负责白名单、参数、权限、超时、执行和审计。

每次新增动作必须同步更新：参数模型、权限等级、超时、副作用、测试、`README.md` 和本文件。
缺少任一项时不得注册。

## 权限等级

| Level | 名称 | 策略 |
| ---: | --- | --- |
| 0 | `READ_ONLY` | 可自动执行 |
| 1 | `LOW_RISK` | 可自动执行 |
| 2 | `HIGH_RISK` | 必须显式确认 |
| 3 | `FORBIDDEN` | 注册期拒绝，永不执行 |

当前 `MAX_AUTO_LEVEL` 为 1。

## `python_version`

| 字段 | 契约 |
| --- | --- |
| level | `0 · READ_ONLY` |
| description | 返回本机 Python 版本 |
| params | 空对象；任何字段都返回 `INVALID_PARAMS` |
| timeout | 5 秒 |
| side effects | `none` |
| implementation | Python 标准库 `platform` 与 `sys` API，不启动子进程 |

成功数据：

```json
{
  "output": "Python 3.11.9",
  "version": "3.11.9",
  "implementation": "CPython",
  "executable": "C:\\Python311\\python.exe"
}
```

## 永久禁止的入口

注册表拒绝保留动作名的精确匹配及嵌入形式，包括：`run_command`、`exec`、`shell`、
`cmd`、`powershell`、`bash`、`run_shell`、`system`、`raw_exec`、`eval`、`python_exec`、
`delete_file`、`format_disk`、`regedit`、`set_acl`、`stop_service`。

服务不接受命令行字符串，不拼接请求参数，不提供任意脚本、文件、进程或 Shell 能力。
