# n8n 2.35.7 → 2.38.6：生产数据克隆升级与回滚方案

更新时间：2026-09-11

本方案只允许在隔离克隆机执行。它不授权连接、停止、修改或升级生产 n8n；克隆
canary 全绿之前，生产继续保持 `EXECUTIONS_DATA_SAVE_ON_SUCCESS=all`。

## 1. 输入与隔离门槛

开始前必须具备：

- 一份一致性的生产 SQLite 备份（生产停写后复制，或用 SQLite `.backup` 生成；不能在
  WAL 正在变化时只 `cp database.sqlite`）。
- 与该库匹配的 `N8N_ENCRYPTION_KEY` 和配置副本。秘密只进入克隆机的受限环境文件，
  不进入命令行、日志或 Git。
- 独立数据目录、独立端口和不可路由到生产内网的网络。建议主服务 `5679`、Task Runner
  broker `5680`，站点克隆 `3000`。
- 旧版 2.35.7 和候选版 2.38.6 两套独立二进制。`deploy/n8n/prepare-upgrade.sh`
  只准备候选运行时，不切 systemd、不碰现有数据目录。

固定目录示例：

```bash
export CANARY_ROOT=/tmp/n8n-upgrade-canary
export N8N_USER_FOLDER="$CANARY_ROOT/data"
export N8N_CLONE_DATABASE_PATH="$N8N_USER_FOLDER/database.sqlite"
export URTORIS_CLONE_CANARY=1
export N8N_CANARY_BASE_URL=http://127.0.0.1:5679
mkdir -p "$CANARY_ROOT"/{source-copy,preupgrade-backup,logs}
```

复制完成后先记录哈希并把原始副本改为只读；所有迁移只发生在 `data/` 的工作副本：

```bash
sha256sum "$CANARY_ROOT/source-copy/database.sqlite" \
  | tee "$CANARY_ROOT/source-copy/database.sqlite.sha256"
cp -a "$CANARY_ROOT/source-copy/." "$CANARY_ROOT/preupgrade-backup/"
cp -a "$CANARY_ROOT/source-copy/." "$N8N_USER_FOLDER/"
chmod -R a-w "$CANARY_ROOT/source-copy"
```

## 2. 先在 2.35.7 建立克隆基线

用旧二进制启动同一工作副本，且强制隔离配置：

```bash
export N8N_PORT=5679
export N8N_RUNNERS_BROKER_PORT=5680
export N8N_LISTEN_ADDRESS=127.0.0.1
export N8N_PUBLIC_API_DISABLED=true
export N8N_DIAGNOSTICS_ENABLED=false
export N8N_COMMUNITY_PACKAGES_ENABLED=false
export N8N_TEMPLATES_ENABLED=false
export N8N_VERSION_NOTIFICATIONS_ENABLED=false
export EXECUTIONS_DATA_SAVE_ON_SUCCESS=all
export EXECUTIONS_DATA_SAVE_ON_ERROR=all
```

基线必须同时满足 `/healthz` 200、`/rest/workflows` 不是 404、W1/W4 webhook 不是
404。只命中 Task Runner broker 的 `/healthz` 不算通过。记录 11 个 workflow 的 id、
active 状态与数据库哈希；基线本身不完整就停止，不做升级。

## 3. 在工作副本上跑 2.38.6 迁移

1. 正常停止 2.35.7 克隆进程，确认 5679/5680 均已释放。
2. 再复制一次 `preupgrade-backup`；这份是回滚唯一来源。
3. 用 2.38.6 指向同一个 `N8N_USER_FOLDER` 启动，让 n8n 自己执行迁移。
4. 日志出现迁移错误、凭据解密错误、端口冲突或自动重启时立即停止，不继续激活。
5. 按依赖顺序发布：4 个 common → global error handler → 5 个业务 → gateway。

候选进程仍只监听回环地址。不要把克隆 webhook、编辑器或 Public API 暴露到公网。

## 4. 11 工作流与终态只读门禁

候选版安装位置不同时显式给出它的 sqlite3 模块；检查器始终用 `OPEN_READONLY`：

```bash
export N8N_SQLITE3_MODULE=/opt/n8n/releases/2.38.6/node_modules/sqlite3
node deploy/n8n/check-upgrade-clone.js
```

通过条件：

- `workflow_entity` 中 11 个目标 workflow 全部存在且 active；
- 5 个业务 workflow 都有“校验 → execution.bound → 归一 → 绑定守卫”；
- 11 个 workflow 仍为成功/失败均保存 `all`；
- common、全局错误、W1/W4 等关键节点均在；
- 没有超过 10 分钟且 `stoppedAt IS NULL` 的 `running`。

随后运行真实 W1/W4（脚本默认生产端口 5678，所以克隆必须显式覆盖设置上面的
`N8N_CANARY_BASE_URL`）：

```bash
bash deploy/n8n/run-finalization-canary.sh
bash deploy/n8n/run-w4-security-canary.sh
```

把两条脚本输出的 execution id 交给只读检查器，要求每个都离开 `running`，有
`stoppedAt` 且 `waitTill` 为空：

```bash
node deploy/n8n/check-upgrade-clone.js <executionId> <executionId> ...
```

## 5. audit 与 issue #37040 观察窗口

```bash
N8N_DIAGNOSTICS_ENABLED=false \
N8N_PUBLIC_API_DISABLED=true \
N8N_COMMUNITY_PACKAGES_ENABLED=false \
N8N_TEMPLATES_ENABLED=false \
N8N_VERSION_NOTIFICATIONS_ENABLED=false \
/opt/n8n/releases/2.38.6/node_modules/.bin/n8n audit \
  | tee "$CANARY_ROOT/logs/n8n-audit.txt"
```

联网版本检查若因网络失败而跳过，必须记为“未验证”，不能写成通过。Code/HTTP 风险节点
只能来自已审的 generated 产物，不允许 `executeCommand` 或未知社区节点。

`all` 观察窗口至少 30 分钟，并至少包含三轮并发 W1 + 一轮 W4。每轮后运行
`check-upgrade-clone.js`，永久 `running` 必须始终为 0。`none` 专项只能在这份工作
副本的**再次复制**上执行，同时修改全局变量与 11 个 workflow 自身设置；测试结束后
销毁该副本，绝不把 `none` 配置带回生产候选。

## 6. 克隆回滚演练

回滚不做 down migration。候选库一旦被 2.38.6 打开，就不再交给 2.35.7：

1. 停止 2.38.6 克隆，确认端口释放。
2. 把迁移后的 `data/` 改名保存为取证副本，不覆盖。
3. 从 `preupgrade-backup/` 创建一个新的 `data-rollback/`。
4. 用 2.35.7 + 原克隆配置启动 `data-rollback/`。
5. 重跑三路径 preflight、旧版只读检查和一条无 Key W1；11 个 active、信封语义与
   requestId/executionId 映射都必须恢复到迁移前基线。
6. 比对 `source-copy` 与 `preupgrade-backup` 哈希，证明回滚源未被候选版修改。

只有“2.38.6 全部门禁通过”与“2.35.7 回滚演练通过”同时成立，才可以另开生产变更
窗口。生产执行仍需单独审批、停写备份、明确负责人和回滚时限，本方案不会自动执行。

## 7. 当前未完成

- 尚未提供生产 DB + 配置的一致性克隆，所以本方案没有被生产形状数据验证。
- 克隆机上的 11 workflow 激活、W1/W4、联网 audit、30 分钟观察窗和回滚演练均未执行。
- 在以上全部完成前，生产保持 2.35.7 与 `EXECUTIONS_DATA_SAVE_ON_SUCCESS=all`。
