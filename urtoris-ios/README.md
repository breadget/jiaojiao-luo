# Urtoris iOS App（SwiftUI）

本目录是 `urtoris` 工作流双端原型的 **iOS 原生客户端**，与仓库里的 Web 端
（`app/`、`components/`）共用同一套 `/api/**` 接口和同一批数据：
创建端发布的工作流，使用端立即可以装载；使用端的每一轮对话都会留下真实运行记录。

界面遵循仓库的 `DESIGN.md`：**一座门厅，四张工作台**。
门厅与机器人端是冷灰纸面，创建端是黑蓝工程台，使用端是炭黑对话台。

## 功能

| 工作端 | iOS 端实现 |
| --- | --- |
| 身份门厅 | 完全对齐 Web 端：深海军蓝说明场 + 纸白入口 + 三个身份（创建端 / 使用端 / 机器人端），入口下方如实显示工作流数量、已发布版本数与连接状态 |
| 使用端 | 会话切换与聊天记录、Agent 轮次（附件位留空）、空会话「想从哪里开始？」、石墨输入容器（38px 圆形发送键 + 加号菜单）、执行详情（路线 / 日志 / 结果）、设置（模型与接口） |
| 创建端 | 命令栏（返回 / 工作流切换 / 保存草稿 / 发布）、基本信息、步骤清单（增删改与上下移、类型端口色）、发布状态、最近运行、新建与删除工作流 |
| 机器人端 | 16:9 深色视频窗、方向控制九宫格（按住行动 / 松手停止）、官方指令按钮、七项状态卡、换行分隔 JSON 链路日志 |

## 运行

### 三种连接方式

App 连的不是另建的后端，就是本仓库自己的 `/api/**`（`npm run dev` 或你的部署）。
服务端的访问边界见 `lib/server/security.ts`，对应关系如下：

| 场景 | 设置 → 工作流服务 | 令牌 |
| --- | --- | --- |
| 模拟器连本机 `npm run dev` | `http://localhost:3000`（默认） | 不需要 |
| 真机连同 Wi-Fi 的 Mac | `http://192.168.x.x:3000` | 不需要（内网请求视为可信会话） |
| 公网域名 / 公网 IP | `https://你的域名` | 需要：创建端写操作填 `URTORIS_ADMIN_TOKEN`，使用端对话填 `URTORIS_API_TOKEN` |

> 原生客户端不带 `Origin`，服务端会按「无来源的跨站调用」要求令牌。
> App 因此对每个请求都声明与服务端同源的 `Origin`，并对使用端路由附带
> `X-Urtoris-Consumer-Client: 1`——这两条正是 `enforceExecutionAccess` 对外开放的入口，
> 与浏览器同源请求等价，不是绕过。

### 1. 先启动 Web 端服务

```bash
cd ..            # 仓库根目录
npm run dev      # 默认 http://localhost:3000
```

### 2. 再运行 iOS App

1. 用 Xcode 打开 `Urtoris.xcodeproj`
2. 选任意 iPhone 模拟器，⌘R
3. App 默认连接 `http://localhost:3000`；模拟器与 Mac 共用回环地址，无需额外配置

### 3. 用自己的 iPhone

1. 工程已写入自动签名与团队 `39T9A8742U`（与仓库里的 `DidaSmartWater-iOS` 同一个 Team）；
   换团队时在 Target → Signing & Capabilities 里改 `Team`，或把 `DEVELOPMENT_TEAM` 改成你的
2. Bundle Identifier 冲突时改成如 `com.yourname.urtoris`
3. 手机连上 Mac，选你的手机为运行目标，⌘R
   - 免费账号签名 7 天过期，过期后重新 ⌘R 即可；首次安装需在手机上信任开发者证书
4. 手机与 Mac 连同一 Wi-Fi，在 App 的 **设置 → 工作流服务** 里填写电脑的局域网地址
   （如 `http://192.168.1.10:3000`），再点「保存并重新连接」

> 仓库里只有 Team 标识（`DEVELOPMENT_TEAM`），**没有也不需要**放签名证书、
> `.p12`、`.mobileprovision` 或任何口令：证书留在本机钥匙串，描述文件由 Xcode 管，
> 私钥进仓库才是真正的事故。

## 演示模式

没有运行服务端时，可以用演示数据把四张工作台走一遍：

```bash
xcrun simctl launch booted cn.urtoris.workflowstudio -demoMode 1
```

- `-startPortal gateway|creator|consumer|robot` 直接进入某张工作台
- `-openFirstConversation` 打开一段演示会话，便于查看对话流与执行详情
- `-serviceURL https://urtoris.cn` 临时指定服务端（不写入设置，仅本次启动生效）

演示数据全部在 `Urtoris/Models/DemoData.swift`，真实运行时不会进入这条分支。

## 与 Web 端的差异（有意为之）

1. **创建端不搬 React Flow 画布**：手机宽度放不下 224px 节点库 + 无限画布 + 326px Inspector。
   iOS 端改成「清单 + 检查器」——步骤仍带类型端口色、仍受 1–12 步约束、保存与发布走同一套
   `/api/workflows`，因此与 Web 端共享同一份草稿与已发布版本。
2. **执行详情进原生 sheet**：对应 Web 端的右侧执行面板，默认收起，不抢占首屏。
3. **会话侧栏改为 sheet**：手机宽度下侧栏会挤掉对话轴，改成页眉点开，保持「对话优先」。
4. **方向键用按住手势**：对应网页端键盘的 `keydown` / `keyup`，按下即下发轮速，松手回到停止。
5. **视频窗如实标注**：Web 端用浏览器 WebRTC 取流；iOS 原生取流需要接入 WebRTC SDK，
   当前只显示协议协商结果与连通状态，并明确写出这一点，不用动画伪造画面。

## 关键配置

- `Services/UrtorisAPI.swift`：接口路径与请求体，与 `app/api/**` 一一对应
- `Services/AppModel.swift`：`http://localhost:3000` 默认地址、模型配置的读写
- `Services/RobotProtocol.swift`：OpenBot v0.8.0 官方协议（端口 7071、`/ws`、`{"driveCmd":{...}}`）
- `Design/Theme.swift`：四张工作台的色板与圆角，数值取自 `app/globals.css` 的 `--urtoris-*`

API Key 只写入本机钥匙串（`Services/Keychain.swift`），与 Web 端「只停留在浏览器」的约定一致。

## 工程结构

```
urtoris-ios/
├── Urtoris.xcodeproj/            # Xcode 工程（含共享 scheme）
└── Urtoris/
    ├── UrtorisApp.swift          # App 入口
    ├── ContentView.swift         # 路由 + 轻色顶栏 + 身份门厅
    ├── Design/
    │   └── Theme.swift           # 四张工作台的色板、圆角、字体层级、品牌图标
    ├── Models/
    │   ├── WorkflowTypes.swift   # 与 lib/workflow-types.ts 对齐的数据模型（宽容解码）
    │   └── DemoData.swift        # 演示数据
    ├── Services/
    │   ├── UrtorisAPI.swift      # /api/state、/api/workflows、/api/agent/chat、/api/consumer/session
    │   ├── AppModel.swift        # 应用状态、会话、创建端编辑、本地配置
    │   ├── RobotProtocol.swift   # OpenBot 官方协议编解码
    │   ├── RobotBridge.swift     # 机器人桥接 WebSocket 客户端
    │   └── Keychain.swift        # API Key 本地存储
    ├── Support/
    │   └── Formatters.swift
    ├── Views/
    │   ├── ConsumerView.swift    # 使用端（含会话、执行详情）
    │   ├── StudioView.swift      # 创建端
    │   ├── RobotConsoleView.swift# 机器人端
    │   └── SettingsView.swift    # 模型与接口设置
    └── Assets.xcassets/          # App 图标（工程内的图标生成脚本见 开发日志）
```

## 注意

- App 是原型客户端，**没有账号体系**，与 Web 端的 `adminTrusted` / 令牌语义保持一致；
  请只在本机或内网运行，不要把 `npm run dev` 直接暴露到公网。
- 机器人端需要先启动桥接服务：`npm run robot:bridge`（官方 Node 控制器，端口 7071），
  手机与电脑在同一网络。
