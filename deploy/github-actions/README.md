# GitHub Actions 生产部署

`.github/workflows/deploy-urtoris.yml` 会在
`codex/graph-runtime-canary` 分支更新后先执行测试、类型检查、代码检查和构建，
全部通过后才向阿里云生产服务器发送经过校验的运行时包。

服务器的 `urtoris-deploy` SSH 用户被强制绑定到
`/usr/local/sbin/urtoris-runtime-deploy`，不能获得交互式终端、端口转发或任意命令执行。
部署程序只接受格式正确的版本 SHA 与 gzip 运行时包、限制包体积，并核验包内的
`URTORIS_RELEASE_SHA` 与传输头一致。

构建发生在 GitHub 的 Linux Runner；阿里云只执行迁移和原子切换已构建的依赖、
产物和服务代码。因此 2 GiB 的生产机不会在发布时执行 `npm ci` 或 `npm run build`。
当前运行中的 `.dev.vars` 不会进入 GitHub 或部署包，而是在服务器本地复制到新版本。

仓库需要一个 Actions Secret：

- `URTORIS_DEPLOY_SSH_KEY`：专用部署私钥。不要复用管理员或个人 SSH 私钥。

网站的 `.dev.vars`、D1 数据和 n8n 数据不通过 GitHub 传输，部署只更换经验证的
程序代码、依赖和构建产物。新版本会先用新版本 Wrangler 对持久化目录
`/var/lib/urtoris/data` 应用尚未执行的 D1 迁移；迁移失败会在停止当前网站前终止
部署。为了给 2 GiB 主机留出迁移内存，n8n 会短暂暂停并在部署结束后恢复。
