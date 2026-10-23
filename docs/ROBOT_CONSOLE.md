# 使用机器人（网页遥控台）

这是「使用机器人」的第一块网页实现：入口在首页身份门厅的第三张门牌，页面是
`/robot`。目标是不改官方协议，先用浏览器把机器人跑起来。

## 组成

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| 协议层 | [`lib/robot-protocol.ts`](../lib/robot-protocol.ts) | 按官方 v0.8.0 编码/解码指令与上报，含方向到左右轮速的映射 |
| 桥接服务 | [`services/robot-bridge/server.ts`](../services/robot-bridge/server.ts) | 机器人 TCP 19400 ⇄ 浏览器 WebSocket 7071/ws 的透传 |
| 遥控台 | [`components/robot/robot-console.tsx`](../components/robot/robot-console.tsx) | 画面、状态、方向控制、键盘、整机指令、指令日志 |
| 入口 | [`components/workflow-lab.tsx`](../components/workflow-lab.tsx) | 首页门厅第三张门牌「使用机器人」 |

## 怎么连上机器人

1. 手机装官方 Robot App（本仓库基线构建的 `robot-debug.apk`），与电脑连同一网络。
2. 电脑上起桥接服务：

   ```bash
   npm run robot:bridge
   # 覆盖端口：ROBOT_BRIDGE_TCP_PORT=19400 ROBOT_BRIDGE_WS_PORT=7071
   ```

3. 机器人 App 里把 **Controller** 设为 `Phone`、**Video** 设为 `WEBRTC`。
   官方实现里手机是 TCP 客户端，会主动连上桥接服务的 19400 端口。
4. 打开 `http://localhost:3000/robot`，点「连接」。
   地址留空表示连接当前页面主机的 7071 端口，也可以手填 `ws://<电脑 IP>:7071/ws`。

机器人接入后：状态面板显示 `LOGS / NOISE / NETWORK / DRIVE_MODE` 与转向灯，方向键或
`W/A/S/D` 遥控，机器人推流后画面区自动播放。

## 协议对应关系（不新增字段）

| 方向 | 报文 | 官方出处 |
| --- | --- | --- |
| 网页 → 机器人 | `{"driveCmd":{"l":1,"r":1}}` | `android/robot/.../common/ControlsFragment.java` |
| 网页 → 机器人 | `{"command":"DRIVE_MODE"｜"SPEED_UP"｜"LOGS"｜...}` | `android/robot/.../utils/Constants.java` |
| 机器人 → 网页 | `{"status":{...}}` | `android/robot/.../utils/ConnectionUtils.java` |
| 机器人 → 网页 | `{"status":{"VIDEO_PROTOCOL":"WEBRTC"}}`、`{"status":{"VIDEO_COMMAND":"START"}}` | `android/robot/.../env/WebRtcServer.java` |
| 机器人 → 网页 | `{"status":{"WEB_RTC_EVENT":"<json>"}}` | 同上（值是被转义的 JSON 字符串） |
| 网页 → 机器人 | `{"webrtc_event":{"type":"answer","sdp":"..."}}`、`{"webrtc_event":{"type":"candidate","candidate":"...","id":"0","label":0}}` | 机器人端 `SignalingHandler` 读取 `type/sdp/candidate/id/label` |

方向到轮速的取值逐条照抄官方 Node 控制器
`controller/node-js/server/commands.js`（`DriveValue` 的 MAX=1、MIN=-1）；重复指令不重复发送，
对应官方的 `DriveCommandReducer`。键盘映射照抄 `controller/node-js/client/keyboard.js`。

桥接服务唯一的“额外”内容是连接通知，形状为 `{"bridge":{...}}`，只发给浏览器、永远不发给
机器人，用来表达「机器人已接入/已断开/机器人不在线，指令被丢弃」。机器人侧看到的协议与
官方控制器服务端完全一致。

## 已验证 / 未验证

已在本机跑通（2026-09-15）：

- `npm test` 中 `tests/robot-protocol.test.ts`、`tests/robot-bridge.test.ts` 共 19 个用例：
  编码、分行、status/视频/WebRTC/bridge 解析、TCP⇄WebSocket 双向透传、掉线通知。
- 用一段模拟机器人（TCP 客户端）连上桥接服务，浏览器点「前进」后机器人端收到
  `{"driveCmd":{"l":1,"r":1}}`；机器人每 5 秒上报的 `{"status":{...}}` 在页面状态面板与
  指令日志里正确显示。

还没有验证（缺真机）：

- 真实手机推流后的 WebRTC 画面。协商流程按官方 `client/webrtc.js` 实现，并补上了官方
  网页客户端漏掉的浏览器侧 ICE 候选上报（机器人端本来就认 `type: candidate`）。
- 机器人 App 在真机上的权限、控制器、视频设置路径。

## 注意

- 桥接服务只监听本机所在局域网，不对外暴露；它不做鉴权，别把它放到公网。
- 页面用 `ws://`，因此请通过 `http://localhost:3000` 访问；用 HTTPS 打开页面时浏览器会
  拦截非加密 WebSocket，需要给桥接服务加 TLS 才能用。
- 网页端只发官方 iOS/Android 控制器会发的字段，没有改动机器人固件或 App 协议。
