import SwiftUI

/// 机器人端：轻色遥控工作面。
/// 深色视频窗承载画面，纸白控制卡承载动作与连通事实；绿色说明连通，橙色说明动作或风险。
struct RobotConsoleView: View {
    var model: AppModel
    @State private var bridge = RobotBridge()

    var body: some View {
        ZStack {
            U.background.ignoresSafeArea()
            VStack(spacing: 0) {
                UrtorisHeader(model: model, title: "使用机器人")
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        videoWindow
                        bridgePanel
                        padPanel
                        commandPanel
                        statusPanel
                        logPanel
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 18)
                    .frame(maxWidth: 720)
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }

    // MARK: - 视频窗

    private var videoWindow: some View {
        ZStack {
            RoundedRectangle(cornerRadius: Radius.surface, style: .continuous)
                .fill(U.navy)
            VStack(spacing: 10) {
                Image(systemName: "video")
                    .font(.system(size: 30, weight: .light))
                    .foregroundStyle(U.paper.opacity(0.55))
                Text(bridge.videoState)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(U.paper)
                Text("浏览器端用 WebRTC 取流；iOS 原生取流需要接入 WebRTC SDK，\n当前如实显示协议协商结果与连通状态。")
                    .font(.system(size: 11))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(U.paper.opacity(0.6))
            }
            .padding(20)
        }
        .aspectRatio(16.0 / 9.0, contentMode: .fit)
        .overlay(
            RoundedRectangle(cornerRadius: Radius.surface, style: .continuous)
                .stroke(U.navy.opacity(0.4), lineWidth: 1)
        )
    }

    // MARK: - 桥接

    private var bridgePanel: some View {
        RobotCard(title: "桥接服务") {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    StateChip(
                        label: bridge.linkState.label,
                        tone: bridge.linkState == .open ? .ok : (bridge.linkState == .error ? .risk : .neutral)
                    )
                    StateChip(
                        label: bridge.robotOnline == true ? "机器人在线" : (bridge.robotOnline == false ? "机器人离线" : "机器人未知"),
                        tone: bridge.robotOnline == true ? .ok : .neutral
                    )
                }

                HStack(spacing: 8) {
                    TextField("ws://192.168.1.10:7071/ws", text: Binding(
                        get: { bridge.bridgeURLText },
                        set: { bridge.bridgeURLText = $0 }
                    ))
                        .textFieldStyle(.plain)
                        .font(.urtorisLabel(11, weight: .regular))
                        .foregroundStyle(U.ink)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(10)
                        .background(U.background, in: RoundedRectangle(
                            cornerRadius: Radius.field, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: Radius.field, style: .continuous)
                                .stroke(U.line, lineWidth: 1)
                        )

                    Button {
                        if bridge.isConnected { bridge.disconnect() } else { bridge.connect() }
                    } label: {
                        Text(bridge.isConnected ? "断开" : "连接")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(U.paperBright)
                            .padding(.horizontal, 16)
                            .frame(height: 42)
                            .background(
                                bridge.isConnected ? U.inkSoft : U.orangeAction,
                                in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                            )
                    }
                    .buttonStyle(.plain)
                }

                Text("桥接服务是仓库里的官方 Node 控制器（端口 7071），手机与电脑需要在同一网络。")
                    .font(.system(size: 11))
                    .foregroundStyle(U.inkSoft)
            }
        }
    }

    // MARK: - 方向盘

    private var padPanel: some View {
        RobotCard(title: "方向控制 · 按住行动，松手停止") {
            VStack(spacing: 10) {
                ForEach(0..<3, id: \.self) { row in
                    HStack(spacing: 10) {
                        ForEach(0..<3, id: \.self) { column in
                            let direction = directionAt(row: row, column: column)
                            DriveButton(
                                direction: direction,
                                isActive: bridge.activeDirection == direction
                            ) {
                                bridge.drive(direction)
                            } onRelease: {
                                if direction != .stop { bridge.drive(.stop) }
                            }
                        }
                    }
                }
            }
            .disabled(!bridge.isConnected)
            .opacity(bridge.isConnected ? 1 : 0.5)
        }
    }

    private func directionAt(row: Int, column: Int) -> RobotProtocol.Direction {
        switch (row, column) {
        case (0, 0): return .forwardLeft
        case (0, 1): return .forward
        case (0, 2): return .forwardRight
        case (1, 0): return .left
        case (1, 1): return .stop
        case (1, 2): return .right
        case (2, 0): return .backwardLeft
        case (2, 1): return .backward
        default: return .backwardRight
        }
    }

    // MARK: - 官方指令

    private var commandPanel: some View {
        RobotCard(title: "小车指令") {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                commandButton("提示音", RobotProtocol.Command.noise)
                commandButton("联网", RobotProtocol.Command.network)
                commandButton("日志", RobotProtocol.Command.logs)
                commandButton("驾驶模式", RobotProtocol.Command.driveMode)
                commandButton("左转向灯", RobotProtocol.Command.indicatorLeft)
                commandButton("右转向灯", RobotProtocol.Command.indicatorRight)
                commandButton("取消转向灯", RobotProtocol.Command.indicatorStop)
                commandButton("加速", RobotProtocol.Command.speedUp)
                commandButton("减速", RobotProtocol.Command.speedDown)
            }
            .disabled(!bridge.isConnected)
            .opacity(bridge.isConnected ? 1 : 0.5)
        }
    }

    private func commandButton(_ label: String, _ command: RobotProtocol.Command) -> some View {
        Button {
            bridge.command(command)
        } label: {
            Text(label)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(U.ink)
                .frame(maxWidth: .infinity)
                .frame(height: 44)
                .background(U.paperBright, in: RoundedRectangle(
                    cornerRadius: Radius.field, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: Radius.field, style: .continuous)
                        .stroke(U.line, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }

    // MARK: - 状态

    private var statusPanel: some View {
        RobotCard(title: "机器人状态") {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                ForEach(RobotProtocol.StatusKey.allCases) { key in
                    HStack(spacing: 8) {
                        Circle()
                            .fill(statusTone(key))
                            .frame(width: 7, height: 7)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(key.label)
                                .font(.system(size: 11))
                                .foregroundStyle(U.inkSoft)
                            Text(statusValue(key))
                                .font(.urtorisLabel(11, weight: .semibold))
                                .foregroundStyle(U.ink)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(U.background, in: RoundedRectangle(
                        cornerRadius: Radius.field, style: .continuous))
                }
            }
        }
    }

    private func statusValue(_ key: RobotProtocol.StatusKey) -> String {
        guard let raw = bridge.status[key.rawValue] else { return "—" }
        if let flag = RobotProtocol.readBoolean(raw) { return flag ? "开" : "关" }
        return RobotProtocol.readText(raw) ?? "—"
    }

    private func statusTone(_ key: RobotProtocol.StatusKey) -> Color {
        guard let raw = bridge.status[key.rawValue] else { return U.line }
        if let flag = RobotProtocol.readBoolean(raw) { return flag ? U.green : U.line }
        return U.orange
    }

    // MARK: - 日志

    private var logPanel: some View {
        RobotCard(title: "链路日志") {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("\(bridge.logs.count) 条 · 最多保留 120 条")
                        .font(.system(size: 11))
                        .foregroundStyle(U.inkSoft)
                    Spacer()
                    Button("清空") { bridge.clearLogs() }
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(U.inkSoft)
                }
                if bridge.logs.isEmpty {
                    Text("连接桥接服务后，收发指令会逐条出现在这里。")
                        .font(.system(size: 12))
                        .foregroundStyle(U.inkSoft)
                }
                ForEach(bridge.logs.prefix(40)) { entry in
                    HStack(alignment: .top, spacing: 8) {
                        Text(marker(entry.direction))
                            .font(.urtorisLabel(10, weight: .bold))
                            .foregroundStyle(color(entry.direction))
                            .frame(width: 18, alignment: .leading)
                        Text(clock(entry.at))
                            .font(.urtorisLabel(10, weight: .regular))
                            .foregroundStyle(U.inkSoft)
                        Text(entry.text)
                            .font(.urtorisLabel(10, weight: .regular))
                            .foregroundStyle(U.ink)
                            .lineLimit(2)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }

    private func marker(_ direction: RobotBridge.LogEntry.Direction) -> String {
        switch direction {
        case .out: return "↑"
        case .inbound: return "↓"
        case .note: return "·"
        }
    }

    private func color(_ direction: RobotBridge.LogEntry.Direction) -> Color {
        switch direction {
        case .out: return U.orange
        case .inbound: return U.green
        case .note: return U.inkSoft
        }
    }

    private func clock(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: date)
    }
}

// MARK: - 元件

struct RobotCard<Content: View>: View {
    var title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(U.ink)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(U.paperBright, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .stroke(U.line, lineWidth: 1)
        )
    }
}

struct StateChip: View {
    enum Tone { case ok, risk, neutral }

    var label: String
    var tone: Tone

    private var color: Color {
        switch tone {
        case .ok: return U.green
        case .risk: return U.orangeAction
        case .neutral: return U.inkSoft
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(color)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(color.opacity(0.1), in: Capsule())
    }
}

/// 方向键：按下即下发轮速，松手回到停止——与网页端按键的 keydown/keyup 语义一致。
struct DriveButton: View {
    var direction: RobotProtocol.Direction
    var isActive: Bool
    var onPress: () -> Void
    var onRelease: () -> Void

    private var symbol: String {
        switch direction {
        case .forwardLeft, .forward, .forwardRight: return "arrow.up"
        case .backwardLeft, .backward, .backwardRight: return "arrow.down"
        case .left: return "arrow.left"
        case .right: return "arrow.right"
        case .stop: return "stop.circle"
        }
    }

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .semibold))
            Text(direction.label)
                .font(.system(size: 11, weight: .semibold))
        }
        .foregroundStyle(isActive ? U.orangeAction : U.ink)
        .frame(maxWidth: .infinity)
        .frame(height: 58)
        .background(U.paperBright, in: RoundedRectangle(
            cornerRadius: Radius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .stroke(isActive ? U.orangeAction : U.line, lineWidth: isActive ? 2 : 1)
        )
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    if !isActive { onPress() }
                }
                .onEnded { _ in onRelease() }
        )
    }
}
