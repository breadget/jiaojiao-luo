# 来源与贡献说明

本公开仓库由 [@breadget](https://github.com/breadget) 导入并继续维护，保留了原协作项目各分支的代码快照。

**本次导入重新建立了 Git 历史。当前提交的作者表示快照导入者和后续维护者，不表示全部历史代码由其独立原创。原协作者与第三方作者的贡献及权利予以保留。**

## 原协作项目的贡献

以下说明依据原始提交记录整理，描述可核实的贡献方向，不代表排他的文件所有权或贡献比例：

| 贡献者 | 原记录中可核实的贡献方向 |
| --- | --- |
| [@breadget](https://github.com/breadget) | Urtoris 工作流原型、可视化编辑器、Graph 发布与 n8n 适配、执行绑定等相关开发，以及本公开仓库的整理与维护 |
| [@22wgj](https://github.com/22wgj) | 安全防护、BYO Key 失败与并发测试、n8n 升级验证、Graph 运行事件管线与真实 n8n 克隆验证，以及计划和进度文档 |
| [@Nieziyun](https://github.com/Nieziyun)（原 Git 署名 Dream010） | OpenBot 导入流程、JiaoJiao-Luo 轮式人形设计与 CAD 产物、Android 产品界面与调试 APK，以及手机启动和 Firebase 相关修复 |
| Pthon Huang（原 Git 署名，未关联到 GitHub 账号） | n8n 工作流工具链基线、执行绑定、工作流 ID 与协议降级及网关转发修复 |

原历史也含 `Urtoris Agent` 与自动化账户的提交，保留其原始署名信息；自动化署名本身不用于认定个人原创归属。

## OpenBot 与第三方组件

`openbot` 分支的上游项目为 [ob-f/OpenBot](https://github.com/ob-f/OpenBot)。其代码、文档、版权声明和许可归原作者与贡献者；分支中的 `LICENSE` 原样保留，包含 Intel ISL 的 MIT 许可声明。本仓库的导入与维护不改变这些权利和许可条件。

其他依赖、组件与第三方文件继续遵循各自的版权与许可；本说明没有为整个协作项目另行指定新许可证。

## 快照来源

原协作仓库：[Nieziyun/jiaojiao-luo](https://github.com/Nieziyun/jiaojiao-luo)（访问遵循原仓库权限）。导入日期：2026-10-23。

| 原分支 | 导入时的原始提交 |
| --- | --- |
| `main` | `4ab2148912c4943fea462fd6ad84558e8e40c422` |
| `codex/agent-behavior-constraints` | `ca1a8243402ff6bd0d4e91e591e0796f04dbb0bf` |
| `codex/graph-runtime-canary` | `2d30ce4102e4ea78db527f89d2ee3f96fe7ff34f` |
| `codex/local-sqlite` | `ee9784c0589a6fb25cce8e17b73e84cf0e4685a7` |
| `codex/publish-ai-workspace` | `a36cb39a2768e07e5ede49c9fe64f51d5676065f` |
| `codex/python-agent-deploy` | `cdb26e2dcf1a4c5c59787192853b8533e9165f60` |
| `codex/toolchain-w4-ssrf-fix` | `a4905cf0f128a76aea7e6054ee2ebe33acef8ce4` |
| `codex/urtoris-ios` | `dc548a52519af46adc49ec8de71894d51dcf7d8d` |
| `openbot` | `43a305accc076fca70634192fabfc9b317c292d1` |
| `toolchain` | `2a50dedce88002c442e8c9f012aa1176b6c0226e` |

`main` 同时保留了本公开仓库在导入前的 README 优化，原公开主分支提交为 `e2cb08adab50fed776487dd22650939e2c5e32db`。

## 原历史署名索引

下表按原仓库所有分支可达提交去重统计，只作来源记录，不用于比较贡献大小。

| 原始 Git 作者署名 | 原历史提交数 |
| --- | --- |
| 22wgj | 6 |
| Bird | 2 |
| Dream010 | 17 |
| Pthon Huang | 4 |
| Urtoris Agent | 1 |
| breadget | 91 |
| github-actions[bot] | 1 |

## 当前分支

`openbot` 导入自原始提交 `43a305accc076fca70634192fabfc9b317c292d1`，保留该提交的文件快照，并补充本来源说明与 README 提示。
