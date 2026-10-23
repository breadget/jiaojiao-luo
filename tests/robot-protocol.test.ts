import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ROBOT_COMMANDS,
  ROBOT_TCP_PORT,
  ROBOT_WS_PORT,
  driveValues,
  encodeDriveCommand,
  encodeRobotCommand,
  encodeWebRtcEvent,
  frameLine,
  parseRobotLine,
  splitLines,
} from '@/lib/robot-protocol';

describe('机器人协议常量', () => {
  it('沿用官方控制器端口', () => {
    assert.equal(ROBOT_TCP_PORT, 19400);
    assert.equal(ROBOT_WS_PORT, 7071);
  });

  it('指令名与官方 Constants.java 一致', () => {
    assert.deepEqual(
      { ...ROBOT_COMMANDS },
      {
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
      },
    );
  });
});

describe('方向映射', () => {
  it('与官方 node 控制器 commands.js 的 DriveValue 取值一致', () => {
    assert.deepEqual(driveValues('forward'), { l: 1, r: 1 });
    assert.deepEqual(driveValues('backward'), { l: -1, r: -1 });
    assert.deepEqual(driveValues('left'), { l: -1, r: 1 });
    assert.deepEqual(driveValues('right'), { l: 1, r: -1 });
    assert.deepEqual(driveValues('forwardLeft'), { l: -0.5, r: 1 });
    assert.deepEqual(driveValues('forwardRight'), { l: 1, r: -0.5 });
    assert.deepEqual(driveValues('backwardLeft'), { l: 0.5, r: -1 });
    assert.deepEqual(driveValues('backwardRight'), { l: -1, r: 0.5 });
    assert.deepEqual(driveValues('stop'), { l: 0, r: 0 });
  });
});

describe('编码', () => {
  it('driveCmd 字段与官方一致', () => {
    assert.equal(
      encodeDriveCommand({ l: 0.4, r: 0.34 }),
      '{"driveCmd":{"l":0.4,"r":0.34}}',
    );
    assert.equal(encodeDriveCommand(driveValues('stop')), '{"driveCmd":{"l":0,"r":0}}');
  });

  it('command 字段与官方一致', () => {
    assert.equal(encodeRobotCommand(ROBOT_COMMANDS.driveMode), '{"command":"DRIVE_MODE"}');
    assert.equal(encodeRobotCommand(ROBOT_COMMANDS.speedUp), '{"command":"SPEED_UP"}');
  });

  it('webrtc_event 字段与机器人端 SignalingHandler 读取的字段一致', () => {
    assert.equal(
      encodeWebRtcEvent({ type: 'answer', sdp: 'v=0' }),
      '{"webrtc_event":{"type":"answer","sdp":"v=0"}}',
    );
    assert.equal(
      encodeWebRtcEvent({
        type: 'candidate',
        candidate: 'candidate:1',
        id: '0',
        label: 0,
      }),
      '{"webrtc_event":{"type":"candidate","candidate":"candidate:1","id":"0","label":0}}',
    );
  });

  it('线路格式是换行分隔', () => {
    assert.equal(frameLine('{"x":1}'), '{"x":1}\n');
  });
});

describe('分行', () => {
  it('把半行留到下一次', () => {
    const first = splitLines('{"status":{"LOGS":true}}');
    assert.deepEqual(first.lines, []);
    assert.equal(first.rest, '{"status":{"LOGS":true}}');

    const second = splitLines('\n{"status":', first.rest);
    assert.deepEqual(second.lines, ['{"status":{"LOGS":true}}']);
    assert.equal(second.rest, '{"status":');
  });

  it('忽略空行', () => {
    const { lines, rest } = splitLines('\n\n{"a":1}\n\n', '');
    assert.deepEqual(lines, ['{"a":1}']);
    assert.equal(rest, '');
  });
});

describe('解析机器人消息', () => {
  it('识别 status 开关', () => {
    const message = parseRobotLine(
      '{"status":{"LOGS":true,"NOISE":false,"NETWORK":true,"DRIVE_MODE":"DUAL","INDICATOR_LEFT":false,"INDICATOR_RIGHT":true,"INDICATOR_STOP":false}}',
    );
    assert.equal(message.kind, 'status');
    if (message.kind !== 'status') return;
    assert.equal(message.values.LOGS, true);
    assert.equal(message.values.DRIVE_MODE, 'DUAL');
    assert.equal(message.values.INDICATOR_RIGHT, true);
  });

  it('识别 VIDEO_PROTOCOL 与 VIDEO_COMMAND', () => {
    const protocol = parseRobotLine('{"status":{"VIDEO_PROTOCOL":"WEBRTC"}}');
    assert.deepEqual(protocol, { kind: 'video-protocol', protocol: 'WEBRTC' });

    const command = parseRobotLine('{"status":{"VIDEO_COMMAND":"START"}}');
    assert.deepEqual(command, { kind: 'video-command', command: 'START' });
  });

  it('识别被转义成字符串的 WEB_RTC_EVENT', () => {
    const line = JSON.stringify({
      status: {
        WEB_RTC_EVENT: JSON.stringify({ type: 'offer', sdp: 'v=0' }),
      },
    });
    const message = parseRobotLine(line);
    assert.deepEqual(message, {
      kind: 'webrtc-event',
      signal: { type: 'offer', sdp: 'v=0' },
    });
  });

  it('识别候选地址与 bye', () => {
    const candidate = parseRobotLine(
      JSON.stringify({
        status: {
          WEB_RTC_EVENT: {
            type: 'candidate',
            candidate: 'candidate:1 1 udp',
            id: 'video',
            label: 0,
          },
        },
      }),
    );
    assert.deepEqual(candidate, {
      kind: 'webrtc-event',
      signal: { type: 'candidate', candidate: 'candidate:1 1 udp', id: 'video', label: 0 },
    });

    const bye = parseRobotLine('{"status":{"WEB_RTC_EVENT":"{\\"type\\":\\"bye\\"}"}}');
    assert.deepEqual(bye, { kind: 'webrtc-event', signal: { type: 'bye' } });
  });

  it('识别桥接服务自己的通知', () => {
    assert.deepEqual(
      parseRobotLine('{"bridge":{"event":"robot-connected","peer":"192.168.1.7:51000"}}'),
      { kind: 'bridge', notice: { event: 'robot-connected', peer: '192.168.1.7:51000' } },
    );
    assert.deepEqual(parseRobotLine('{"bridge":{"event":"robot-state","connected":true}}'), {
      kind: 'bridge',
      notice: { event: 'robot-state', connected: true },
    });
    assert.deepEqual(
      parseRobotLine('{"bridge":{"event":"robot-offline","dropped":"{\\"command\\":\\"LOGS\\"}"}}'),
      {
        kind: 'bridge',
        notice: { event: 'robot-offline', dropped: '{"command":"LOGS"}' },
      },
    );
  });

  it('无法解析的内容不会抛错', () => {
    assert.deepEqual(parseRobotLine('not json'), { kind: 'unknown', raw: 'not json' });
    assert.deepEqual(parseRobotLine(''), { kind: 'unknown', raw: '' });
    assert.deepEqual(parseRobotLine('{"bridge":{"event":"other"}}'), {
      kind: 'unknown',
      raw: '{"bridge":{"event":"other"}}',
    });
  });
});
