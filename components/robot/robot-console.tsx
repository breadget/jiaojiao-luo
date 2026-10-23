'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CircleStop,
  Gamepad2,
  Loader2,
  Power,
  Radio,
  Video,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ROBOT_COMMANDS,
  ROBOT_STATUS_KEYS,
  ROBOT_WS_PATH,
  ROBOT_WS_PORT,
  driveValues,
  encodeDriveCommand,
  encodeRobotCommand,
  encodeWebRtcEvent,
  frameLine,
  parseRobotLine,
  readBooleanStatus,
  readTextStatus,
  splitLines,
  type DriveDirection,
  type RobotStatusKey,
} from '@/lib/robot-protocol';

type LinkState = 'idle' | 'connecting' | 'open' | 'error';
type RobotLink = 'unknown' | 'online' | 'offline';
type VideoState = 'idle' | 'negotiating' | 'live';

type LogEntry = {
  id: number;
  at: string;
  direction: 'out' | 'in' | 'note';
  text: string;
};

const MAX_LOG_ENTRIES = 120;

const STATUS_LABELS: Record<RobotStatusKey, string> = {
  LOGS: '日志',
  NOISE: '提示音',
  NETWORK: '联网',
  DRIVE_MODE: '驾驶模式',
  INDICATOR_LEFT: '左转向灯',
  INDICATOR_RIGHT: '右转向灯',
  INDICATOR_STOP: '取消转向灯',
};

const DRIVE_BUTTONS: Array<{
  direction: DriveDirection;
  label: string;
  icon: typeof ArrowUp;
  className: string;
}> = [
  { direction: 'forwardLeft', label: '左前', icon: ArrowUp, className: 'robot-pad-forwardLeft' },
  { direction: 'forward', label: '前进', icon: ArrowUp, className: 'robot-pad-forward' },
  { direction: 'forwardRight', label: '右前', icon: ArrowUp, className: 'robot-pad-forwardRight' },
  { direction: 'left', label: '左转', icon: ArrowLeft, className: 'robot-pad-left' },
  { direction: 'stop', label: '停止', icon: CircleStop, className: 'robot-pad-stop' },
  { direction: 'right', label: '右转', icon: ArrowRight, className: 'robot-pad-right' },
  { direction: 'backwardLeft', label: '左后', icon: ArrowDown, className: 'robot-pad-backwardLeft' },
  { direction: 'backward', label: '后退', icon: ArrowDown, className: 'robot-pad-backward' },
  { direction: 'backwardRight', label: '右后', icon: ArrowDown, className: 'robot-pad-backwardRight' },
];

const MOVE_KEYS = new Set(['w', 'a', 's', 'd']);

function defaultBridgeUrl(): string {
  const scheme =
    typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host =
    typeof window !== 'undefined' && window.location.hostname
      ? window.location.hostname
      : '127.0.0.1';
  return `${scheme}://${host}:${ROBOT_WS_PORT}${ROBOT_WS_PATH}`;
}

function nowLabel(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

const noopSubscribe = () => () => {};

/**
 * 公网 HTTPS 页面无法连接明文 ws:// 桥接服务（浏览器按混合内容拦截）。
 * 用 useSyncExternalStore 读环境，避免服务端渲染与客户端首次渲染不一致。
 */
function useSecurePage(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => window.location.protocol === 'https:',
    () => false,
  );
}

export function RobotConsole() {
  const [bridgeUrl, setBridgeUrl] = useState('');
  const [linkState, setLinkState] = useState<LinkState>('idle');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [robotLink, setRobotLink] = useState<RobotLink>('unknown');
  const [status, setStatus] = useState<Record<string, string | boolean>>({});
  const [direction, setDirection] = useState<DriveDirection>('stop');
  const [videoState, setVideoState] = useState<VideoState>('idle');
  const [log, setLog] = useState<LogEntry[]>([]);
  const securePage = useSecurePage();

  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const robotBufferRef = useRef('');
  const lastDriveRef = useRef('');
  const heldKeysRef = useRef<Set<string>>(new Set());
  const logIdRef = useRef(0);

  const pushLog = useCallback((direction: LogEntry['direction'], text: string) => {
    logIdRef.current += 1;
    const entry: LogEntry = {
      id: logIdRef.current,
      at: nowLabel(),
      direction,
      text,
    };
    setLog((current) => [...current.slice(-(MAX_LOG_ENTRIES - 1)), entry]);
  }, []);

  const sendLine = useCallback(
    (line: string) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        pushLog('note', `未连接桥接服务，指令没有发送：${line}`);
        return false;
      }
      socket.send(frameLine(line));
      pushLog('out', line);
      return true;
    },
    [pushLog],
  );

  const closePeer = useCallback(() => {
    const peer = peerRef.current;
    if (peer) {
      peer.getSenders().forEach((sender) => sender.track?.stop());
      peer.close();
    }
    peerRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setVideoState('idle');
  }, []);

  const ensurePeer = useCallback(() => {
    if (peerRef.current) return peerRef.current;

    const peer = new RTCPeerConnection();

    peer.addEventListener('track', (event) => {
      const stream = event.streams[0];
      if (stream && videoRef.current) {
        videoRef.current.srcObject = stream;
        void videoRef.current.play().catch(() => undefined);
        setVideoState('live');
      }
    });

    peer.addEventListener('icecandidate', (event) => {
      if (!event.candidate) return;
      sendLine(
        encodeWebRtcEvent({
          type: 'candidate',
          candidate: event.candidate.candidate,
          id: event.candidate.sdpMid ?? '',
          label: event.candidate.sdpMLineIndex ?? 0,
        }),
      );
    });

    peer.addEventListener('connectionstatechange', () => {
      if (peer.connectionState === 'connected') setVideoState('live');
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        setVideoState('idle');
      }
    });

    peerRef.current = peer;
    return peer;
  }, [sendLine]);

  const applyDrive = useCallback(
    (next: DriveDirection) => {
      setDirection(next);
      const line = encodeDriveCommand(driveValues(next));
      // 官方 DriveCommandReducer：与上一条相同的指令不重复发送。
      if (line === lastDriveRef.current) return;
      if (sendLine(line)) lastDriveRef.current = line;
    },
    [sendLine],
  );

  const handleRobotLine = useCallback(
    (line: string) => {
      const message = parseRobotLine(line);
      switch (message.kind) {
        case 'status':
          setStatus((current) => ({ ...current, ...message.values }));
          pushLog('in', line);
          break;

        case 'video-protocol':
          pushLog('note', `机器人声明的视频协议：${message.protocol}`);
          if (message.protocol !== 'WEBRTC') {
            pushLog('note', '只有 WEBRTC 视频能在网页里播放，请在机器人 App 里改成 WEBRTC。');
          }
          break;

        case 'video-command':
          if (message.command === 'START') {
            ensurePeer();
            setVideoState('negotiating');
            pushLog('note', '机器人开始推流，正在建立 WebRTC 连接…');
          } else {
            closePeer();
            pushLog('note', '机器人停止了推流。');
          }
          pushLog('in', line);
          break;

        case 'webrtc-event': {
          const signal = message.signal;
          if (signal.type === 'offer') {
            const peer = ensurePeer();
            void (async () => {
              try {
                await peer.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
                const answer = await peer.createAnswer();
                await peer.setLocalDescription(answer);
                sendLine(encodeWebRtcEvent({ type: 'answer', sdp: answer.sdp ?? '' }));
              } catch (error) {
                pushLog('note', `WebRTC 协商失败：${String(error)}`);
                setVideoState('idle');
              }
            })();
          } else if (signal.type === 'candidate') {
            const peer = peerRef.current;
            if (peer) {
              void peer
                .addIceCandidate({
                  candidate: signal.candidate,
                  sdpMid: signal.id,
                  sdpMLineIndex: signal.label,
                })
                .catch((error) => pushLog('note', `候选地址被拒绝：${String(error)}`));
            }
          } else if (signal.type === 'bye') {
            closePeer();
          }
          pushLog('in', line);
          break;
        }

        case 'bridge':
          if (message.notice.event === 'robot-connected') {
            setRobotLink('online');
            pushLog(
              'note',
              `机器人已接入桥接服务${message.notice.peer ? `（${message.notice.peer}）` : ''}`,
            );
          } else if (message.notice.event === 'robot-disconnected') {
            setRobotLink('offline');
            applyDrive('stop');
            closePeer();
            pushLog('note', '机器人已断开，已发送停止指令。');
          } else if (message.notice.event === 'robot-state') {
            setRobotLink(message.notice.connected ? 'online' : 'offline');
            pushLog(
              'note',
              message.notice.connected ? '桥接服务报告机器人在线。' : '桥接服务还在等机器人接入。',
            );
          } else {
            pushLog('note', `机器人不在线，指令被丢弃：${message.notice.dropped}`);
          }
          break;

        default:
          pushLog('in', line);
          break;
      }
    },
    [applyDrive, closePeer, ensurePeer, pushLog, sendLine],
  );

  const disconnect = useCallback(() => {
    applyDrive('stop');
    closePeer();
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close();
    setLinkState('idle');
    setRobotLink('unknown');
  }, [applyDrive, closePeer]);

  const connect = useCallback(() => {
    if (socketRef.current) return;
    setLinkError(null);
    setLinkState('connecting');
    // 输入框留空时按当前页面主机推断桥接地址，避免在服务端渲染阶段读 window。
    const target = bridgeUrl.trim() || defaultBridgeUrl();
    pushLog('note', `正在连接桥接服务 ${target}`);

    let socket: WebSocket;
    try {
      socket = new WebSocket(target);
    } catch (error) {
      setLinkState('error');
      setLinkError(String(error));
      return;
    }
    socketRef.current = socket;
    robotBufferRef.current = '';

    socket.addEventListener('open', () => {
      setLinkState('open');
      pushLog('note', '已连接桥接服务。');
    });

    socket.addEventListener('message', (event) => {
      const { lines, rest } = splitLines(String(event.data), robotBufferRef.current);
      robotBufferRef.current = rest;
      for (const line of lines) handleRobotLine(line);
    });

    socket.addEventListener('close', () => {
      socketRef.current = null;
      setLinkState('idle');
      setRobotLink('unknown');
      closePeer();
      pushLog('note', '与桥接服务的连接已关闭。');
    });

    socket.addEventListener('error', () => {
      setLinkState('error');
      setLinkError(
        `连接失败：${target}。请确认已运行 npm run robot:bridge，且页面与桥接服务在同一台机器上。`,
      );
    });
  }, [bridgeUrl, closePeer, handleRobotLine, pushLog]);

  // 键盘控制：按键映射照官方 Node 控制器 controller/node-js/client/keyboard.js。
  useEffect(() => {
    const isEditable = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

    const directionForKeys = (): DriveDirection => {
      const held = heldKeysRef.current;
      const forward = held.has('w');
      const backward = held.has('s');
      const left = held.has('a');
      const right = held.has('d');
      if (forward && left) return 'forwardLeft';
      if (forward && right) return 'forwardRight';
      if (backward && left) return 'backwardLeft';
      if (backward && right) return 'backwardRight';
      if (forward) return 'forward';
      if (backward) return 'backward';
      if (left) return 'left';
      if (right) return 'right';
      return 'stop';
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditable(event.target)) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

      if (MOVE_KEYS.has(key)) {
        event.preventDefault();
        heldKeysRef.current.add(key);
        applyDrive(directionForKeys());
        return;
      }

      switch (key) {
        case ' ':
          event.preventDefault();
          sendLine(encodeRobotCommand(ROBOT_COMMANDS.logs));
          break;
        case 'm':
          sendLine(encodeRobotCommand(ROBOT_COMMANDS.driveMode));
          break;
        case 'n':
          sendLine(encodeRobotCommand(ROBOT_COMMANDS.noise));
          break;
        case 'q':
          sendLine(encodeRobotCommand(ROBOT_COMMANDS.speedDown));
          break;
        case 'e':
          sendLine(encodeRobotCommand(ROBOT_COMMANDS.speedUp));
          break;
        case 'ArrowLeft':
          event.preventDefault();
          sendLine(encodeRobotCommand(ROBOT_COMMANDS.indicatorLeft));
          break;
        case 'ArrowRight':
          event.preventDefault();
          sendLine(encodeRobotCommand(ROBOT_COMMANDS.indicatorRight));
          break;
        case 'ArrowUp':
          event.preventDefault();
          sendLine(encodeRobotCommand(ROBOT_COMMANDS.indicatorStop));
          break;
        case 'ArrowDown':
          event.preventDefault();
          sendLine(encodeRobotCommand(ROBOT_COMMANDS.network));
          break;
        case 'Escape':
          heldKeysRef.current.clear();
          applyDrive('stop');
          break;
        default:
          break;
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (isEditable(event.target)) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (!MOVE_KEYS.has(key)) return;
      heldKeysRef.current.delete(key);
      applyDrive(directionForKeys());
    };

    const onBlur = () => {
      heldKeysRef.current.clear();
      applyDrive('stop');
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [applyDrive, sendLine]);

  useEffect(
    () => () => {
      peerRef.current?.close();
      socketRef.current?.close();
    },
    [],
  );

  const driveMode = readTextStatus(status, 'DRIVE_MODE');
  const robotBadge = useMemo(() => {
    if (robotLink === 'online') return { label: '机器人在线', tone: 'online' as const };
    if (robotLink === 'offline') return { label: '等待机器人接入', tone: 'idle' as const };
    return { label: '连接状态未知', tone: 'idle' as const };
  }, [robotLink]);

  return (
    <div className="robot-shell">
      <header className="urtoris-header">
        <Link href="/" prefetch={false} className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <Gamepad2 />
          </span>
          <span>Urtoris</span>
        </Link>

        <p className="header-title">使用机器人</p>

        <div className="connection-state" aria-label={`桥接服务：${linkState}`}>
          <Radio aria-hidden="true" />
          <span>
            {linkState === 'open'
              ? '桥接服务已连接'
              : linkState === 'connecting'
                ? '正在连接桥接服务'
                : linkState === 'error'
                  ? '桥接服务连接失败'
                  : '桥接服务未连接'}
          </span>
          <span
            className={`connection-dot${
              linkState === 'open'
                ? ''
                : linkState === 'connecting'
                  ? ' connection-dot-loading'
                  : linkState === 'error'
                    ? ' connection-dot-error'
                    : ' robot-dot-idle'
            }`}
            aria-hidden="true"
          />
        </div>
      </header>

      <main className="robot-main">
        <section className="robot-stage" aria-labelledby="robot-video-title">
          <div className="robot-video">
            <video ref={videoRef} playsInline autoPlay muted />
            {videoState !== 'live' ? (
              <div className="robot-video-placeholder">
                <Video aria-hidden="true" />
                <strong id="robot-video-title">
                  {videoState === 'negotiating' ? '正在协商视频通道…' : '等待机器人推流'}
                </strong>
                <span>
                  机器人 App 的 Video 选 WEBRTC、Controller 选 Phone，并让手机与这台电脑在同一网络。
                </span>
              </div>
            ) : null}
            <span className={`robot-video-chip robot-video-chip-${videoState}`}>
              {videoState === 'live' ? '实时画面' : videoState === 'negotiating' ? '协商中' : '无画面'}
            </span>
          </div>

          <div className="robot-pad" aria-label="方向控制">
            {DRIVE_BUTTONS.map((button) => {
              const Icon = button.icon;
              const active = direction === button.direction;
              return (
                <Button
                  key={button.direction}
                  type="button"
                  variant={button.direction === 'stop' ? 'default' : 'outline'}
                  className={`robot-pad-button ${button.className}${
                    active ? ' robot-pad-button-active' : ''
                  }`}
                  onClick={() => applyDrive(button.direction)}
                >
                  <Icon aria-hidden="true" />
                  <span>{button.label}</span>
                </Button>
              );
            })}
          </div>

          <div className="robot-keys">
            <span className="robot-label">键盘</span>
            <span>W/A/S/D 行驶</span>
            <span>Q/E 减速 · 加速</span>
            <span>空格 日志</span>
            <span>M 驾驶模式</span>
            <span>N 提示音</span>
            <span>方向键 转向灯 · 联网</span>
            <span>Esc 停止</span>
          </div>
        </section>

        <aside className="robot-side">
          <section className="robot-card" aria-labelledby="robot-link-title">
            <header className="robot-card-heading">
              <h2 id="robot-link-title">桥接服务</h2>
              <Badge variant="outline" className={`robot-badge robot-badge-${robotBadge.tone}`}>
                {robotBadge.label}
              </Badge>
            </header>

            <div className="robot-field">
              <span className="robot-label">WebSocket 地址</span>
              <Input
                value={bridgeUrl}
                aria-label="桥接服务 WebSocket 地址"
                spellCheck={false}
                onChange={(event) => setBridgeUrl(event.target.value)}
                placeholder={`ws://127.0.0.1:${ROBOT_WS_PORT}${ROBOT_WS_PATH}`}
              />
              <span className="robot-mono">留空则连接当前页面主机的 {ROBOT_WS_PORT} 端口</span>
            </div>

            <div className="robot-actions">
              {linkState === 'open' ? (
                <Button type="button" variant="outline" onClick={disconnect}>
                  <Power aria-hidden="true" />
                  断开
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={connect}
                  disabled={linkState === 'connecting'}
                >
                  {linkState === 'connecting' ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Power aria-hidden="true" />
                  )}
                  连接
                </Button>
              )}
            </div>

            <p className="robot-hint">
              本机先运行 <code>npm run robot:bridge</code>；机器人 App 在 General 面板把 Controller
              设为 Phone，它会作为 TCP 客户端连上 19400 端口。
            </p>

            {securePage ? (
              <p className="robot-warning">
                这是 HTTPS 公网页面，浏览器会拦截明文 <code>ws://</code>。真正遥控请用电脑上的
                <code> http://localhost:3000/robot</code>；若要给公网页面用，得先给桥接服务加上 TLS
                再用 <code>wss://</code>。
              </p>
            ) : null}

            {linkError ? (
              <p className="robot-error" role="alert">
                {linkError}
              </p>
            ) : null}
          </section>

          <section className="robot-card" aria-labelledby="robot-status-title">
            <header className="robot-card-heading">
              <h2 id="robot-status-title">机器人状态</h2>
              {driveMode ? <span className="robot-mono">DRIVE_MODE {driveMode}</span> : null}
            </header>
            <ul className="robot-status-list">
              {ROBOT_STATUS_KEYS.filter((key) => key !== 'DRIVE_MODE').map((key) => {
                const value = readBooleanStatus(status, key);
                return (
                  <li key={key}>
                    <span className="robot-label">{STATUS_LABELS[key]}</span>
                    <span
                      className={`robot-status-value${
                        value === true
                          ? ' robot-status-on'
                          : value === false
                            ? ' robot-status-off'
                            : ''
                      }`}
                    >
                      {value === null ? '—' : value ? '开' : '关'}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="robot-card" aria-labelledby="robot-command-title">
            <header className="robot-card-heading">
              <h2 id="robot-command-title">整机指令</h2>
              <span className="robot-mono">官方 command 字段</span>
            </header>
            <div className="robot-command-grid">
              {[
                { label: '加速', command: ROBOT_COMMANDS.speedUp },
                { label: '减速', command: ROBOT_COMMANDS.speedDown },
                { label: '驾驶模式', command: ROBOT_COMMANDS.driveMode },
                { label: '提示音', command: ROBOT_COMMANDS.noise },
                { label: '日志', command: ROBOT_COMMANDS.logs },
                { label: '联网', command: ROBOT_COMMANDS.network },
                { label: '左转向灯', command: ROBOT_COMMANDS.indicatorLeft },
                { label: '右转向灯', command: ROBOT_COMMANDS.indicatorRight },
                { label: '取消转向灯', command: ROBOT_COMMANDS.indicatorStop },
              ].map((item) => (
                <Button
                  key={item.command}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => sendLine(encodeRobotCommand(item.command))}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </section>

          <section className="robot-card robot-log-card" aria-labelledby="robot-log-title">
            <header className="robot-card-heading">
              <h2 id="robot-log-title">指令日志</h2>
              <Button type="button" variant="ghost" size="sm" onClick={() => setLog([])}>
                清空
              </Button>
            </header>
            <ol className="robot-log">
              {log.length === 0 ? (
                <li className="robot-log-empty">还没有收发记录。</li>
              ) : (
                log
                  .slice()
                  .reverse()
                  .map((entry) => (
                    <li key={entry.id} className={`robot-log-row robot-log-${entry.direction}`}>
                      <span className="robot-mono">{entry.at}</span>
                      <span className="robot-log-arrow" aria-hidden="true">
                        {entry.direction === 'out' ? '↑' : entry.direction === 'in' ? '↓' : '·'}
                      </span>
                      <code>{entry.text}</code>
                    </li>
                  ))
              )}
            </ol>
          </section>
        </aside>
      </main>
    </div>
  );
}
