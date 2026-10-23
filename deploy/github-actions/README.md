# GitHub Actions 生产部署

`.github/workflows/deploy-urtoris.yml` 会在
`codex/graph-runtime-canary` 分支更新后先执行测试、类型检查、代码检查和构建，
全部通过后才向阿里云生产服务器（`8.133.252.143`）发送经过校验的运行时包。
`urtoris.cn` 的生产入口使用这台阿里云 ECS。腾讯云 `43.132.210.43` 即将到期，
不得再作为部署目标；迁移过程中它只用于保留回滚数据和转发旧 DNS 缓存的请求。

服务器的 `urtoris-deploy` SSH 用户被强制绑定到
`/usr/local/sbin/urtoris-runtime-deploy`，不能获得交互式终端、端口转发或任意命令执行。
部署程序只接受格式正确的版本 SHA 与 gzip 运行时包、限制包体积，并核验包内的
`URTORIS_RELEASE_SHA` 与传输头一致。

构建发生在 GitHub 的 Linux Runner；服务器只执行迁移和原子切换已构建的依赖、
产物和服务代码。因此 2 GiB 的生产机不会在发布时执行 `npm ci` 或 `npm run build`。
当前运行中的 `.dev.vars` 不会进入 GitHub 或部署包，而是在服务器本地复制到新版本。

仓库需要一个 Actions Secret：

- `URTORIS_DEPLOY_SSH_KEY`：阿里云服务器专用部署私钥。不要复用管理员或个人 SSH 私钥。

部署后必须核对公网 `/api/state` 的 `releaseSha` 与本次提交一致，不能只依赖
`/studio` 返回 200，也不能把另一台实例的健康检查当成公网发布成功。

网站的 `.dev.vars`、D1 数据和 n8n 数据不通过 GitHub 传输，部署只更换经验证的
程序代码、依赖和构建产物。新版本会先用新版本 Wrangler 对持久化目录
`/var/lib/urtoris/data` 应用尚未执行的 D1 迁移；迁移失败会在停止当前网站前终止
部署。为了给 2 GiB 主机留出迁移内存，n8n 会短暂暂停并在部署结束后恢复。

画布程序发布前需先按 [`deploy/README.md`](../README.md#画布程序后台服务) 的 root
准备步骤安装 worker 用户、私有配置、持久化目录和 systemd unit，并安装本目录的
新版 `urtoris-runtime-deploy` 到受限入口。准备脚本兼容仍无 worker 源码的旧生产版本，
只 enable unit，不启动服务，也不打印或轮换已匹配的令牌。未准备的服务器会在迁移、
停站之前拒绝部署。

CI 在生产 Node 22 下导入 worker，运行时包同时携带 `tsx`、`tsconfig.json` 与所有
被跟踪的服务/共享源码。部署在原子切换前停止 worker；课程恢复就绪后验证 worker
的本机健康检查，任何后续失败都恢复旧应用和 worker 原先的 active 状态。任务与
下载文件固定保存在 `/var/lib/urtoris-workflow-program`，不会随代码回滚或重复执行。
