/**
 * Urtoris 机器人桥接服务（网页端第一块）。
 *
 * 官方 OpenBot 的 “Phone” 控制器模式下，手机上运行的机器人 App 是 TCP 客户端，
 * 主动连到控制器服务端的 19400 端口；网页端则通过 WebSocket 连同一个服务端。
 * 这个服务就是把两端接起来的最小实现：
 *
 *   机器人 App  --TCP 19400, 换行分隔 JSON-->  桥接服务  --WebSocket /ws-->  浏览器
 *
 * 桥接服务对官方协议只做透传：机器人发来的每一行原样转给浏览器，浏览器发来的每一行原样
 * 转给机器人。唯一的例外是带 `{"bridge":{...}}` 外包装的连接通知，那是桥接服务自己的
 * 状态提示，永远不会发给机器人。
 *
 * 运行：npm run robot:bridge（可用 ROBOT_BRIDGE_TCP_PORT / ROBOT_BRIDGE_WS_PORT 覆盖端口）
 */
import { createServer as createTcpServer, type Server, type Socket } from 'node:net';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  ROBOT_TCP_PORT,
  ROBOT_WS_PATH,
  ROBOT_WS_PORT,
  frameLine,
  splitCompleteLines,
  splitLines,
} from '../../lib/robot-protocol';

export type RobotBridgeOptions = {
  tcpPort?: number;
  wsPort?: number;
  wsPath?: string;
  host?: string;
  log?: (line: string) => void;
};

export type RobotBridge = {
  tcpPort: number;
  wsPort: number;
  robotConnected(): boolean;
  browserCount(): number;
  close(): Promise<void>;
};

type RobotBridgeState = {
  browserClients: Set<WebSocket>;
  robotSocket: Socket | null;
  robotPeer: string | null;
};

const READY = 1;

function rawDataToText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export async function createRobotBridge(
  options: RobotBridgeOptions = {},
): Promise<RobotBridge> {
  const tcpPort = options.tcpPort ?? ROBOT_TCP_PORT;
  const wsPort = options.wsPort ?? ROBOT_WS_PORT;
  const wsPath = options.wsPath ?? ROBOT_WS_PATH;
  const host = options.host ?? '0.0.0.0';
  const log = options.log ?? (() => {});

  const state: RobotBridgeState = {
    browserClients: new Set(),
    robotSocket: null,
    robotPeer: null,
  };

  const notify = (notice: Record<string, unknown>) => {
    const payload = JSON.stringify({ bridge: notice });
    for (const client of state.browserClients) {
      if (client.readyState === READY) client.send(frameLine(payload));
    }
  };

  const forwardToRobots = (line: string) => {
    const socket = state.robotSocket;
    if (!socket || socket.destroyed) {
      log(`机器人未连接，丢弃：${line}`);
      notify({ event: 'robot-offline', dropped: line });
      return false;
    }
    socket.write(frameLine(line));
    return true;
  };

  const forwardToBrowsers = (line: string) => {
    for (const client of state.browserClients) {
      if (client.readyState === READY) client.send(frameLine(line));
    }
  };

  // ---------- 机器人侧：TCP 19400 ----------
  let robotRemainder = '';
  const tcpServer: Server = createTcpServer((socket) => {
    const peer = `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? 0}`;

    if (state.robotSocket && !state.robotSocket.destroyed) {
      log(`已有机器人在线，替换旧连接：${state.robotPeer}`);
      state.robotSocket.destroy();
    }

    state.robotSocket = socket;
    state.robotPeer = peer;
    robotRemainder = '';
    log(`机器人已接入：${peer}`);
    notify({ event: 'robot-connected', peer });

    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      const { lines, rest } = splitLines(chunk.toString('utf8'), robotRemainder);
      robotRemainder = rest;
      for (const line of lines) {
        log(`机器人 → 浏览器：${line}`);
        forwardToBrowsers(line);
      }
    });

    const drop = () => {
      if (state.robotSocket !== socket) return;
      state.robotSocket = null;
      const previousPeer = state.robotPeer;
      state.robotPeer = null;
      robotRemainder = '';
      log(`机器人断开：${previousPeer}`);
      notify({ event: 'robot-disconnected', peer: previousPeer ?? undefined });
    };

    socket.on('close', drop);
    socket.on('error', (error) => {
      log(`机器人连接出错：${error.message}`);
      drop();
    });
  });

  await new Promise<void>((resolve, reject) => {
    tcpServer.once('error', reject);
    tcpServer.listen(tcpPort, host, () => {
      tcpServer.off('error', reject);
      resolve();
    });
  });

  // ---------- 浏览器侧：WebSocket ----------
  const wsServer = new WebSocketServer({ port: wsPort, path: wsPath, host });
  await new Promise<void>((resolve, reject) => {
    wsServer.once('error', reject);
    wsServer.once('listening', () => {
      wsServer.off('error', reject);
      resolve();
    });
  });

  wsServer.on('connection', (client, request) => {
    const peer = request.socket.remoteAddress ?? '?';
    state.browserClients.add(client);
    log(`浏览器已连接：${peer}（当前 ${state.browserClients.size} 个）`);
    client.send(
      frameLine(
        JSON.stringify({
          bridge: {
            event: 'robot-state',
            connected: state.robotSocket !== null && !state.robotSocket.destroyed,
          },
        }),
      ),
    );

    client.on('message', (data) => {
      for (const line of splitCompleteLines(rawDataToText(data))) {
        log(`浏览器 → 机器人：${line}`);
        forwardToRobots(line);
      }
    });

    const cleanup = () => {
      state.browserClients.delete(client);
      log(`浏览器断开：${peer}（剩余 ${state.browserClients.size} 个）`);
    };
    client.on('close', cleanup);
    client.on('error', cleanup);
  });

  const boundTcpPort = (tcpServer.address() as { port: number } | null)?.port ?? tcpPort;
  const boundWsPort = (wsServer.address() as { port: number } | null)?.port ?? wsPort;

  return {
    tcpPort: boundTcpPort,
    wsPort: boundWsPort,
    robotConnected: () => state.robotSocket !== null && !state.robotSocket.destroyed,
    browserCount: () => state.browserClients.size,
    async close() {
      for (const client of state.browserClients) client.terminate();
      state.browserClients.clear();
      state.robotSocket?.destroy();
      state.robotSocket = null;
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
    },
  };
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const tcpPort = Number(process.env.ROBOT_BRIDGE_TCP_PORT ?? ROBOT_TCP_PORT);
  const wsPort = Number(process.env.ROBOT_BRIDGE_WS_PORT ?? ROBOT_WS_PORT);
  const log = (line: string) => {
    console.log(`[${new Date().toISOString()}] ${line}`);
  };

  const bridge = await createRobotBridge({ tcpPort, wsPort, log });
  log(`桥接服务已启动：机器人 TCP ${bridge.tcpPort}，浏览器 WebSocket ${bridge.wsPort}${ROBOT_WS_PATH}`);
  log('在机器人 App 的 General 面板把 Controller 设为 Phone 即可接入。');

  const shutdown = async () => {
    log('正在关闭桥接服务…');
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
