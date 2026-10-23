# 工作流草稿变更

这个目录存放**草稿级**的工作流变更：只改草稿，不发布、不激活、不导入 n8n。

## wf_demo_triage · 客户请求分流（带会话记忆）

| 文件                                      | 内容                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `wf_demo_triage.graph.json`               | 目标 Graph 草稿（WorkflowGraphV1，可直接 PUT 到 `/api/workflows/wf_demo_triage/graph`） |
| `wf_demo_triage.compile-preview.n8n.json` | 只读编译预览产物（Adapter v1.1，`active: false`），用于评审，**没有导入任何 n8n**       |
| `wf_demo_triage.change-note.md`           | 变更说明：保留了什么、改了什么、没做什么、还有什么限制                                  |

## 产物状态

这三个文件是可复核的静态交付物，**不声明当前任何 D1 环境的可变状态**。
Graph 文件里的 `revision` 只是夹具值；实际保存前必须先 GET 目标环境当前
revision，由 PUT 的乐观锁决定是否接受。

预览产物用发布版本 1 确定性编译，仅供结构审查；`active: false`，不含
credentials。真正导入前仍须在克隆 n8n 挂载 `headerAuth` / `openAiApi` 并跑 canary。

## 在别的环境应用这份草稿

优先在 Studio 打开 `wf_demo_triage`，确认画布后点 Save；「编译预览」通过后可直接
「下载 n8n JSON」。如果用 API，令牌只从环境变量读取，不写进任何文件：

```bash
export URTORIS_ADMIN_TOKEN='...'          # 目标环境的管理员令牌

# 1. 读取当前 revision（不要猜）
current_revision="$(curl -sS \
  -H "Authorization: Bearer $URTORIS_ADMIN_TOKEN" \
  "http://127.0.0.1:3000/api/workflows/wf_demo_triage/graph" \
  | jq -r '.graph.revision')"

# 2. 用乐观锁保存草稿
curl -sS -X PUT "http://127.0.0.1:3000/api/workflows/wf_demo_triage/graph" \
  -H "Authorization: Bearer $URTORIS_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -c --argjson revision "$current_revision" \
    '{graph: ., expectedRevision: $revision}' drafts/wf_demo_triage.graph.json)"

# 3. 只读编译预览（不写库、不导入 n8n）
curl -sS -X POST "http://127.0.0.1:3000/api/workflows/wf_demo_triage/graph/preview" \
  -H "Authorization: Bearer $URTORIS_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{}'
```

发布快照是单独步骤（`POST .../graph/publish`）；发布也不等于导入 n8n。
在真实事件来源与克隆 canary 完成前，Deploy 继续锁定。
