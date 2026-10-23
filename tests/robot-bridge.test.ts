import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { createRobotBridge, type RobotBridge } from '../services/robot-bridge/server';

const bridges: RobotBridge[] = [];
const sockets: Socket[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const bridge of bridges.splice(0)) await bridge.close();
});

/** 带等待能力的行读取器：把收到的文本按换行切好排队。 */
function createLineReader() {
  const queue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let remainder = '';

  const push = (chunk: string) => {
    const parts = (remainder + chunk).split('\n');
    remainder = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.trim();
      if (!line) continue;
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else queue.push(line);
    }
  };

  return {
    push,
    next(timeoutMs = 2000): Promise<string> {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(handler);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('等待消息超时'));
        }, timeoutMs);
        const handler = (line: string) => {
          clearTimeout(timer);
          resolve(line);
        };
        waiters.push(handler);
      });
    },
  };
}

async function startBridge() {
  const bridge = await createRobotBridge({ tcpPort: 0, wsPort: 0, host: '127.0.0.1' });
  bridges.push(bridge);
  return bridge;
}

async function connectRobot(port: number) {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const candidate = connect(port, '127.0.0.1', () => resolve(candidate));
    candidate.once('error', reject);
  });
  sockets.push(socket);
  return socket;
}

async function connectBrowser(port: number) {
  const reader = createLineReader();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  clients.push(socket);
  socket.addEventListener('message', (event) => reader.push(String(event.data)));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('浏览器连接失败')), { once: true });
  });
  return { socket, reader };
}

describe('机器人桥接服务', () => {
  it('把机器人上报原样转给浏览器', async () => {
    const bridge = await startBridge();
    const { reader } = await connectBrowser(bridge.wsPort);
    assert.deepEqual(JSON.parse(await reader.next()), {
      bridge: { event: 'robot-state', connected: false },
    });

    const robot = await connectRobot(bridge.tcpPort);
    assert.deepEqual(JSON.parse(await reader.next()), {
      bridge: { event: 'robot-connected', peer: '127.0.0.1:' + String(robot.localPort) },
    });

    const statusLine = '{"status":{"LOGS":true,"NETWORK":false}}';
    robot.write(`${statusLine}\n`);
    assert.equal(await reader.next(), statusLine);
    assert.equal(bridge.robotConnected(), true);
  });

  it('把浏览器的指令原样转给机器人并补上换行', async () => {
    const bridge = await startBridge();
    const robot = await connectRobot(bridge.tcpPort);
    const robotReader = createLineReader();
    robot.on('data', (chunk) => robotReader.push(chunk.toString('utf8')));

    const { socket } = await connectBrowser(bridge.wsPort);
    socket.send('{"driveCmd":{"l":1,"r":1}}\n');
    assert.equal(await robotReader.next(), '{"driveCmd":{"l":1,"r":1}}');

    socket.send('{"command":"LOGS"}');
    assert.equal(await robotReader.next(), '{"command":"LOGS"}');
    assert.equal(bridge.browserCount(), 1);
  });

  it('机器人不在线时回一条桥接通知，不伪造机器人流量', async () => {
    const bridge = await startBridge();
    const { socket, reader } = await connectBrowser(bridge.wsPort);
    await reader.next(); // robot-state

    socket.send('{"command":"LOGS"}\n');
    assert.deepEqual(JSON.parse(await reader.next()), {
      bridge: { event: 'robot-offline', dropped: '{"command":"LOGS"}' },
    });
  });

  it('机器人断开后通知浏览器', async () => {
    const bridge = await startBridge();
    const { reader } = await connectBrowser(bridge.wsPort);
    await reader.next(); // robot-state

    const robot = await connectRobot(bridge.tcpPort);
    await reader.next(); // robot-connected
    robot.destroy();

    const notice = JSON.parse(await reader.next()) as {
      bridge: { event: string; peer?: string };
    };
    assert.equal(notice.bridge.event, 'robot-disconnected');
    assert.equal(bridge.robotConnected(), false);
  });
});
