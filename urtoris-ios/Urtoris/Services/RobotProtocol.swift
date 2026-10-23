import Foundation

/// OpenBot v0.8.0 官方协议的 iOS 端实现，逐条对应 `lib/robot-protocol.ts`。
/// 只做官方协议的编码/解码，不新增字段。
enum RobotProtocol {
    /// 官方网页控制器让浏览器连接的 WebSocket 端口与路径。
    static let wsPort = 7071
    static let wsPath = "/ws"
    /// 官方控制器服务端监听机器人 TCP 连接的端口（仅用于说明）。
    static let tcpPort = 19400

    /// 官方控制器指令名（android/robot/.../utils/Constants.java）。
    enum Command: String {
        case drive = "DRIVE_CMD"
        case logs = "LOGS"
        case noise = "NOISE"
        case network = "NETWORK"
        case driveMode = "DRIVE_MODE"
        case indicatorLeft = "INDICATOR_LEFT"
        case indicatorRight = "INDICATOR_RIGHT"
        case indicatorStop = "INDICATOR_STOP"
        case speedUp = "SPEED_UP"
        case speedDown = "SPEED_DOWN"
    }

    enum Direction: String, CaseIterable, Identifiable {
        case forwardLeft, forward, forwardRight
        case left, stop, right
        case backwardLeft, backward, backwardRight

        var id: String { rawValue }

        var label: String {
            switch self {
            case .forwardLeft: return "左前"
            case .forward: return "前进"
            case .forwardRight: return "右前"
            case .left: return "左转"
            case .stop: return "停止"
            case .right: return "右转"
            case .backwardLeft: return "左后"
            case .backward: return "后退"
            case .backwardRight: return "右后"
            }
        }

        /// 与官方 controller/node-js/server/commands.js 的左右轮速完全一致。
        var values: (l: Double, r: Double) {
            switch self {
            case .forward: return (1, 1)
            case .backward: return (-1, -1)
            case .left: return (-1, 1)
            case .right: return (1, -1)
            case .forwardLeft: return (-0.5, 1)
            case .forwardRight: return (1, -0.5)
            case .backwardLeft: return (0.5, -1)
            case .backwardRight: return (-1, 0.5)
            case .stop: return (0, 0)
            }
        }
    }

    /// 官方状态键（ConnectionUtils.getStatus）。
    enum StatusKey: String, CaseIterable, Identifiable {
        case logs = "LOGS"
        case noise = "NOISE"
        case network = "NETWORK"
        case driveMode = "DRIVE_MODE"
        case indicatorLeft = "INDICATOR_LEFT"
        case indicatorRight = "INDICATOR_RIGHT"
        case indicatorStop = "INDICATOR_STOP"

        var id: String { rawValue }

        var label: String {
            switch self {
            case .logs: return "日志"
            case .noise: return "提示音"
            case .network: return "联网"
            case .driveMode: return "驾驶模式"
            case .indicatorLeft: return "左转向灯"
            case .indicatorRight: return "右转向灯"
            case .indicatorStop: return "取消转向灯"
            }
        }
    }

    // MARK: - 编码

    static func encodeDrive(_ values: (l: Double, r: Double)) -> String {
        "{\"driveCmd\":{\"l\":\(trim(values.l)),\"r\":\(trim(values.r))}}"
    }

    static func encodeCommand(_ command: Command) -> String {
        "{\"command\":\"\(command.rawValue)\"}"
    }

    private static func trim(_ value: Double) -> String {
        if value == value.rounded() { return String(Int(value)) }
        return String(format: "%.1f", value)
    }

    /// 官方线路格式：换行分隔的 JSON。
    static func frame(_ message: String) -> String { message + "\n" }

    // MARK: - 解码

    enum Message {
        case status([String: String])
        case videoProtocol(String)
        case videoCommand(String)
        case webRtcEvent
        case bridge(String)
        case unknown(String)
    }

    /// 解析机器人端的一行消息。机器人会把 WEB_RTC_EVENT 之类的字段塞进 status，
    /// 值可能是被转义过的 JSON 字符串，两种形态都要认。
    static func parse(_ line: String) -> Message {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .unknown(trimmed)
        }

        if let bridge = object["bridge"] as? [String: Any], let event = bridge["event"] as? String {
            return .bridge(event)
        }
        if let status = object["status"] as? [String: Any] {
            var values: [String: String] = [:]
            for (key, raw) in status {
                if let text = raw as? String {
                    values[key] = text
                } else if let flag = raw as? Bool {
                    values[key] = flag ? "1" : "0"
                } else if let number = raw as? NSNumber {
                    values[key] = number.stringValue
                }
            }
            if let protocolName = values["VIDEO_PROTOCOL"] {
                return .videoProtocol(protocolName)
            }
            if let command = values["VIDEO_COMMAND"] {
                return .videoCommand(command)
            }
            if values["WEB_RTC_EVENT"] != nil {
                return .webRtcEvent
            }
            return .status(values)
        }
        if let event = object["webrtc_event"] as? [String: Any] {
            _ = event
            return .webRtcEvent
        }
        return .unknown(trimmed)
    }

    /// 官方状态值里布尔量以 "1"/"0" 或 true/false 出现。
    static func readBoolean(_ value: String?) -> Bool? {
        guard let value else { return nil }
        switch value.lowercased() {
        case "1", "true", "yes", "on": return true
        case "0", "false", "no", "off": return false
        default: return nil
        }
    }

    static func readText(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }
}
