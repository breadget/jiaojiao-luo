# 机器人桥接服务

官方 OpenBot App 在 “Phone” 控制器模式下是 TCP 客户端，主动连到控制器服务端的 19400 端口；
官方网页控制器再通过 WebSocket 7071 连同一个服务端。这个服务就是那两端的接点：

```
机器人 App  --TCP 19400，换行分隔 JSON-->  robot-bridge  --WebSocket 7071/ws-->  浏览器 /robot
```

## 运行

```bash
npm run robot:bridge
# 可选：ROBOT_BRIDGE_TCP_PORT=19400 ROBOT_BRIDGE_WS_PORT=7071 npm run robot:bridge
```

## 行为

- 机器人发来的每一行**原样**转给所有浏览器；浏览器发来的每一条消息**原样**转给机器人。
- 机器人同一时间只保留一条连接，新连接会顶掉旧连接并通知浏览器。
- 机器人不在线时，指令不会伪造发送，浏览器会收到 `{"bridge":{"event":"robot-offline","dropped":"..."}}`。
- `{"bridge":{...}}` 是桥接服务自己的状态通知（`robot-connected` / `robot-disconnected` /
  `robot-state` / `robot-offline`），只发浏览器，永远不发给机器人。

## 测试

```bash
node --experimental-test-module-mocks --import tsx \
  --import ./tests/helpers/loader-hooks.mjs --test tests/robot-bridge.test.ts
```

## 注意

这是一个本地工具：不做鉴权、不加 TLS，只应在自己机器的局域网里使用，不要暴露到公网。
安全边界与 `services/local-control` 一样按“只在本机/局域网”对待。
