# n8n 正式化材料

该目录用于把已运行的 n8n 固定到 `https://n8n.urtoris.cn`，并为 W1–W5 加入确定性 `requestId ↔ executionId` 映射和 `mode/degraded` 响应字段。

- `nginx-http.conf`：签发证书前的 HTTP/ACME 配置。
- `nginx-https.conf`：正式 HTTPS 反向代理。
- `n8n.service`：使用独立 `n8n` 用户，仅监听本机回环地址。
- `migrate-service.py`：备份后迁移数据目录、环境变量和服务配置；失败时自动恢复。
- `patch-observability.py`：在 ECS 内部修改新导出的工作流 JSON，不向本机复制生产工作流或凭据。
- `patch-conversation-history.mjs`：对服务端已发布导出打补丁，让完整历史通过请求校验，W1 按真实角色传入全部历史，并移除固定的冒烟测试身份和 120 字回复限制。导入后必须重新 Publish 并通过真实 n8n 到模型的全链路验收。
- `check-production.js`：只读检查发布状态、观测节点、执行保存设置和陈旧 `running`；可追加 execution ID 验证精确执行是否定稿。
- `run-finalization-canary.sh`：并发运行 3 次无 Key W1，验证规则降级、映射唯一性与 SQLite 定稿。
- `apply-runtime-guardrails.py`：备份环境文件后关闭未使用的 Public API、Swagger、社区包和模板市场；健康检查失败自动回滚。
- `patch-w4-allowlist.py`：把 W4 的 HTTP 目标限制为 Postman Echo 的三个固定演示路径，避免任意公网转发和 SSRF。
- `run-w4-security-canary.sh`：验证允许目标可访问、任意公网/localhost 均被拒绝，且拒绝分支没有进入 HTTP Request 节点。
- `check-upgrade-clone.js`：只读核对 2.38.6 升级克隆的 11 个工作流、保存策略、
  关键节点、迁移表、指定执行终态与陈旧 `running`；缺少显式 clone 标记或路径不像
  clone/canary 时直接拒绝运行。

完整的生产数据克隆升级与回滚演练见
[`docs/N8N_2_38_6_UPGRADE_PLAN.md`](../../docs/N8N_2_38_6_UPGRADE_PLAN.md)。

`patch-observability.py` 的输入必须是新的、已发布工作流导出目录；输出目录必须不存在。导入前保留原始导出和 n8n 数据库备份，导入后重新 Publish 受影响的工作流并运行协议验证。

## 当前生产保护线

- n8n 2.35.7 必须暂用 `EXECUTIONS_DATA_SAVE_ON_SUCCESS=all`；本实例在 `none` 下复现过成功执行无法从 `running` 定稿的问题。
- 用 `EXECUTIONS_DATA_MAX_AGE=72` 与 `EXECUTIONS_DATA_PRUNE_MAX_COUNT=2000` 控制数据量，升级后也必须先用精确 execution ID 连续验证三次，才能考虑恢复 `none`。
- 排查僵尸执行只匹配陈旧的 `status='running'`。不要把全部 `finished=0` 当成僵尸；终态 `error` 行可能仍为 `finished=0`。
- `n8n.urtoris.cn` 只有在域名备案/边缘放行后才能作为正式公网入口；DNS-01 签证书不会绕过基于 SNI 的边缘拦截。
