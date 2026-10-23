/**
 * OpenBot v0.8.0 官方协议的网页端实现。
 *
 * 这个文件只负责“把官方协议原样编码/解码”。任何改动都要先能在官方代码里找到对应实现，
 * 仓库里对应位置（fork 的 astra/baseline 记录见 OpenBot 仓库 astra/BASELINE-v0.8.0.md）：
 *
 * - 传输：手机上运行的 OpenBot App 在 “Phone” 控制器模式下作为 TCP 客户端连到控制器服务端的
 *   19400 端口，双向消息都是换行分隔的 JSON
 *   （android/robot/src/main/java/org/openbot/env/NetworkServiceConnection.java）。
 * - 下行指令：{"driveCmd":{"l":<float>,"r":<float>}} 与 {"command":"<NAME>"}
 *   （android/robot/src/main/java/org/openbot/common/ControlsFragment.java、
 *   android/robot/src/main/java/org/openbot/utils/Constants.java）。
 * - 上行上报：{"status":{...}}
 *   （android/robot/src/main/java/org/openbot/utils/ConnectionUtils.java）。
 * - 视频协商：{"status":{"VIDEO_PROTOCOL":"WEBRTC"}}、{"status":{"VIDEO_COMMAND":"START"}}、
 *   {"status":{"WEB_RTC_EVENT":"<json 字符串>"}}；浏览器回 {"webrtc_event":{...}}
 *   （android/robot/src/main/java/org/openbot/env/WebRtcServer.java）。
 *
 * 我们不新增、不改写官方协议字段：网页端发出的每一条消息，官方 Android 控制器 App 都能发。
 */

/** 官方控制器服务端监听机器人 TCP 连接的端口（controller/node-js/server/bot-connection.js）。 */
export const ROBOT_TCP_PORT = 19400;

/** 官方网页控制器让浏览器连接的 WebSocket 端口（controller/node-js/server/browser-connection.js）。 */
export const ROBOT_WS_PORT = 7071;

/** 官方 WebSocket 路径（controller/node-js/client/connection.js 使用 /ws）。 */
export const ROBOT_WS_PATH = '/ws';

/** 官方控制器指令名（android/robot/.../utils/Constants.java）。 */
export const ROBOT_COMMANDS = {
  drive: 'DRIVE_CMD',
  logs: 'LOGS',
  noise: 'NOISE',
  network: 'NETWORK',
  driveMode: 'DRIVE_MODE',
  indicatorLeft: 'INDICATOR_LEFT',
  indicatorRight: 'INDICATOR_RIGHT',
  indicatorStop: 'INDICATOR_STOP',
  speedUp: 'SPEED_UP',
  speedDown: 'SPEED_DOWN',
  connected: 'CONNECTED',
  disconnected: 'DISCONNECTED',
} as const;

export type RobotCommandName =
  (typeof ROBOT_COMMANDS)[keyof typeof ROBOT_COMMANDS];

/** 官方状态键（android/robot/.../utils/ConnectionUtils.java 的 getStatus）。 */
export const ROBOT_STATUS_KEYS = [
  'LOGS',
  'NOISE',
  'NETWORK',
  'DRIVE_MODE',
  'INDICATOR_LEFT',
  'INDICATOR_RIGHT',
  'INDICATOR_STOP',
] as const;

export type RobotStatusKey = (typeof ROBOT_STATUS_KEYS)[number];

/**
 * 方向到左右轮速的映射，逐条照抄官方 Node 控制器 controller/node-js/server/commands.js：
 * MAX = 1.0、MIN = -1.0，前进/后退满速，原地转向 ±1，斜向是 0.5/1 组合。
 */
export type DriveDirection =
  | 'stop'
  | 'forward'
  | 'backward'
  | 'left'
  | 'right'
  | 'forwardLeft'
  | 'forwardRight'
  | 'backwardLeft'
  | 'backwardRight';

export type DriveValues = { l: number; r: number };

export function driveValues(direction: DriveDirection): DriveValues {
  switch (direction) {
    case 'forward':
      return { l: 1, r: 1 };
    case 'backward':
      return { l: -1, r: -1 };
    case 'left':
      return { l: -1, r: 1 };
    case 'right':
      return { l: 1, r: -1 };
    case 'forwardLeft':
      return { l: -0.5, r: 1 };
    case 'forwardRight':
      return { l: 1, r: -0.5 };
    case 'backwardLeft':
      return { l: 0.5, r: -1 };
    case 'backwardRight':
      return { l: -1, r: 0.5 };
    case 'stop':
    default:
      return { l: 0, r: 0 };
  }
}

export function sameDriveValues(a: DriveValues, b: DriveValues): boolean {
  return a.l === b.l && a.r === b.r;
}

/** {"driveCmd":{"l":..,"r":..}}，与官方控制器发送的字段完全一致。 */
export function encodeDriveCommand(values: DriveValues): string {
  return JSON.stringify({ driveCmd: { l: values.l, r: values.r } });
}

/** {"command":"<NAME>"}，与官方控制器发送的字段完全一致。 */
export function encodeRobotCommand(name: RobotCommandName): string {
  return JSON.stringify({ command: name });
}

/**
 * {"webrtc_event":{...}}，机器人端 SignalingHandler 读取 type/sdp/candidate/id/label。
 */
export function encodeWebRtcEvent(event: Record<string, unknown>): string {
  return JSON.stringify({ webrtc_event: event });
}

/** 官方线路格式：换行分隔的 JSON。 */
export function frameLine(message: string): string {
  return `${message}\n`;
}

/**
 * 把收到的数据块按换行切开，返回完整行与剩余的半行。
 * 与官方控制器 server/bot-connection.js 的 MessageBuffer('\n') 行为一致。
 */
export function splitLines(
  chunk: string,
  remainder = '',
): { lines: string[]; rest: string } {
  const combined = remainder + chunk;
  const parts = combined.split('\n');
  const rest = parts.pop() ?? '';
  const lines = parts.map((line) => line.trim()).filter((line) => line.length > 0);
  return { lines, rest };
}

/**
 * WebSocket 消息是离散的，不像 TCP 那样会被切成任意片段：官方浏览器客户端每条消息都会
 * 补上换行（controller/node-js/client/connection.js 的 `data + '\n'`），但这里对没有结尾
 * 换行的消息也按完整指令处理，避免半行卡在缓冲里。
 */
export function splitCompleteLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export type WebRtcSignal =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'candidate'; candidate: string; id: string; label: number }
  | { type: 'bye' };

/** 桥接服务自己产生的通知，机器人永远看不到这些帧。 */
export type RobotBridgeEvent =
  | { event: 'robot-connected'; peer?: string }
  | { event: 'robot-disconnected'; peer?: string }
  | { event: 'robot-state'; connected: boolean }
  | { event: 'robot-offline'; dropped: string };

export type RobotMessage =
  | { kind: 'status'; values: Record<string, string | boolean> }
  | { kind: 'video-protocol'; protocol: string }
  | { kind: 'video-command'; command: string }
  | { kind: 'webrtc-event'; signal: WebRtcSignal }
  | { kind: 'bridge'; notice: RobotBridgeEvent }
  | { kind: 'unknown'; raw: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 解析机器人端的一行消息。
 *
 * 机器人把 WEB_RTC_EVENT 之类的字段塞进 status，并且值是被转义过的 JSON 字符串
 * （ConnectionUtils.createStatus(String, String)），所以这里两种形态都要认。
 */
export function parseRobotLine(line: string): RobotMessage {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'unknown', raw: line };

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(trimmed));
  } catch {
    return { kind: 'unknown', raw: trimmed };
  }
  if (!parsed) return { kind: 'unknown', raw: trimmed };

  const bridge = asRecord(parsed.bridge);
  if (bridge) {
    const event = asText(bridge.event);
    if (
      event === 'robot-connected' ||
      event === 'robot-disconnected' ||
      event === 'robot-state' ||
      event === 'robot-offline'
    ) {
      if (event === 'robot-state') {
        return {
          kind: 'bridge',
          notice: { event, connected: bridge.connected === true },
        };
      }
      if (event === 'robot-offline') {
        return { kind: 'bridge', notice: { event, dropped: asText(bridge.dropped) } };
      }
      const peer = asText(bridge.peer);
      return { kind: 'bridge', notice: peer ? { event, peer } : { event } };
    }
    return { kind: 'unknown', raw: trimmed };
  }

  const envelope = asRecord(parsed.status) ?? parsed;

  const webrtcRaw = envelope.WEB_RTC_EVENT;
  if (webrtcRaw !== undefined) {
    const signal = parseWebRtcSignal(webrtcRaw);
    if (signal) return { kind: 'webrtc-event', signal };
  }

  if (typeof envelope.VIDEO_PROTOCOL === 'string') {
    return { kind: 'video-protocol', protocol: envelope.VIDEO_PROTOCOL };
  }

  if (typeof envelope.VIDEO_COMMAND === 'string') {
    return { kind: 'video-command', command: envelope.VIDEO_COMMAND };
  }

  if (parsed.status !== undefined) {
    const values: Record<string, string | boolean> = {};
    for (const [key, value] of Object.entries(envelope)) {
      if (typeof value === 'boolean' || typeof value === 'string') {
        values[key] = value;
      } else if (typeof value === 'number') {
        values[key] = String(value);
      }
    }
    return { kind: 'status', values };
  }

  return { kind: 'unknown', raw: trimmed };
}

function parseWebRtcSignal(raw: unknown): WebRtcSignal | null {
  let payload = raw;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }

  const event = asRecord(payload);
  if (!event) return null;

  switch (asText(event.type)) {
    case 'offer':
      return { type: 'offer', sdp: asText(event.sdp) };
    case 'answer':
      return { type: 'answer', sdp: asText(event.sdp) };
    case 'candidate': {
      const candidate = asText(event.candidate);
      if (!candidate) return null;
      return {
        type: 'candidate',
        candidate,
        id: asText(event.id),
        label: typeof event.label === 'number' ? event.label : 0,
      };
    }
    case 'bye':
      return { type: 'bye' };
    default:
      return null;
  }
}

/** 界面用的可读状态：只挑官方 status 里的布尔开关和驾驶模式。 */
export function readBooleanStatus(
  values: Record<string, string | boolean>,
  key: RobotStatusKey,
): boolean | null {
  const value = values[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

export function readTextStatus(
  values: Record<string, string | boolean>,
  key: string,
): string | null {
  const value = values[key];
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}
