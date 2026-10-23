import Foundation
import Observation

/// 机器人桥接 WebSocket 客户端：换行分隔的 JSON，与官方控制器服务端一致。
@MainActor
@Observable
final class RobotBridge {
    enum LinkState: Equatable {
        case idle, connecting, open, error

        var label: String {
            switch self {
            case .idle: return "未连接"
            case .connecting: return "连接中"
            case .open: return "已连接"
            case .error: return "连接失败"
            }
        }
    }

    struct LogEntry: Identifiable, Equatable {
        enum Direction { case out, inbound, note }

        let id = UUID()
        var at: Date = Date()
        var direction: Direction = .note
        var text: String = ""
    }

    private(set) var linkState: LinkState = .idle
    private(set) var linkError: String?
    private(set) var robotOnline: Bool?
    private(set) var status: [String: String] = [:]
    private(set) var videoState: String = "未连接"
    private(set) var logs: [LogEntry] = []
    private(set) var activeDirection: RobotProtocol.Direction?
    var bridgeURLText: String = ""

    private var task: URLSessionWebSocketTask?
    private var receiveLoop: Task<Void, Never>?
    private static let maxLogs = 120

    init() {
        bridgeURLText = "ws://127.0.0.1:\(RobotProtocol.wsPort)\(RobotProtocol.wsPath)"
    }

    var isConnected: Bool { linkState == .open }

    func connect() {
        disconnect()
        guard let url = URL(string: bridgeURLText.trimmingCharacters(in: .whitespaces)) else {
            linkState = .error
            linkError = "桥接地址无效"
            return
        }
        linkState = .connecting
        linkError = nil
        append(.note, "连接 \(url.absoluteString)")
        let socket = URLSession.shared.webSocketTask(with: url)
        task = socket
        socket.resume()
        linkState = .open
        receiveLoop = Task { [weak self] in
            await self?.receive(on: socket)
        }
    }

    func disconnect() {
        receiveLoop?.cancel()
        receiveLoop = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        if linkState != .idle { append(.note, "已断开桥接") }
        linkState = .idle
        robotOnline = nil
        videoState = "未连接"
    }

    func send(_ payload: String, note: String? = nil) {
        guard let task else {
            linkError = "桥接未连接"
            return
        }
        let framed = RobotProtocol.frame(payload)
        if let note { append(.out, note) } else { append(.out, payload) }
        task.send(.string(framed)) { [weak self] error in
            guard let error else { return }
            Task { @MainActor in self?.append(.note, "发送失败：\(error.localizedDescription)") }
        }
    }

    /// 方向盘按下：直接下发左右轮速。
    func drive(_ direction: RobotProtocol.Direction) {
        activeDirection = direction
        send(RobotProtocol.encodeDrive(direction.values), note: "drive \(direction.label)")
    }

    func command(_ command: RobotProtocol.Command) {
        send(RobotProtocol.encodeCommand(command), note: "command \(command.rawValue)")
    }

    // MARK: - 接收

    private func receive(on socket: URLSessionWebSocketTask) async {
        while !Task.isCancelled {
            do {
                let message = try await socket.receive()
                let text: String
                switch message {
                case .string(let value): text = value
                case .data(let data): text = String(decoding: data, as: UTF8.self)
                @unknown default: text = ""
                }
                handle(text)
            } catch {
                if !Task.isCancelled {
                    linkState = .error
                    linkError = "桥接连接中断"
                    append(.note, "连接中断：\(error.localizedDescription)")
                }
                return
            }
        }
    }

    private func handle(_ chunk: String) {
        for line in chunk.split(separator: "\n").map(String.init) where !line.trimmingCharacters(in: .whitespaces).isEmpty {
            switch RobotProtocol.parse(line) {
            case .status(let values):
                status.merge(values) { _, new in new }
                apply(values)
                append(.inbound, line)
            case .videoProtocol(let name):
                videoState = "协商中（\(name)）"
                append(.inbound, line)
            case .videoCommand(let command):
                videoState = command.uppercased() == "START" ? "协商中" : "未连接"
                append(.inbound, line)
            case .webRtcEvent:
                videoState = "协商中"
                append(.inbound, "WEB_RTC_EVENT")
            case .bridge(let event):
                switch event {
                case "robot-connected": robotOnline = true
                case "robot-disconnected": robotOnline = false
                case "robot-offline": robotOnline = false
                default: break
                }
                append(.note, "桥接事件 \(event)")
            case .unknown(let raw):
                append(.inbound, raw)
            }
        }
    }

    private func apply(_ values: [String: String]) {
        if let connected = RobotProtocol.readBoolean(values["CONNECTED"]) {
            robotOnline = connected
        }
        if let mode = values["DRIVE_MODE"] {
            append(.note, "驾驶模式 \(mode)")
        }
    }

    private func append(_ direction: LogEntry.Direction, _ text: String) {
        logs.insert(LogEntry(at: Date(), direction: direction, text: text), at: 0)
        if logs.count > Self.maxLogs { logs.removeLast(logs.count - Self.maxLogs) }
    }

    func clearLogs() { logs.removeAll() }
}
