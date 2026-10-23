import SwiftUI

struct ContentView: View {
    @State private var model = AppModel()

    var body: some View {
        Group {
            switch model.portal {
            case .gateway:
                GatewayView(model: model)
            case .consumer:
                ConsumerView(model: model)
            case .creator:
                StudioView(model: model)
            case .robot:
                RobotConsoleView(model: model)
            }
        }
        .animation(.easeInOut(duration: 0.18), value: model.portal)
        .task { await model.refresh() }
    }
}

// MARK: - 轻色顶栏（门厅与机器人端共用）

struct UrtorisHeader: View {
    var model: AppModel
    var title: String
    var showsBack: Bool = true

    var body: some View {
        HStack(spacing: 14) {
            Button {
                if showsBack { model.portal = .gateway }
            } label: {
                HStack(spacing: 10) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .fill(U.navy)
                            .frame(width: 34, height: 34)
                        WorkflowGlyph(color: .white, lineWidth: 2.2)
                            .frame(width: 18, height: 18)
                    }
                    Text("Urtoris")
                        .font(.system(size: 18, weight: .heavy))
                        .tracking(-0.4)
                        .foregroundStyle(U.ink)
                }
            }
            .buttonStyle(.plain)
            .allowsHitTesting(showsBack)

            Spacer(minLength: 6)

            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(U.headerTitle)
                .lineLimit(1)
                .layoutPriority(1)

            Spacer(minLength: 6)

            ConnectionStateView(model: model)
        }
        .padding(.horizontal, 18)
        .frame(height: Metrics.headerHeight)
        .frame(maxWidth: .infinity)
        .background(U.headerBackground)
        .overlay(alignment: .bottom) { Hairline(color: U.headerLine) }
    }
}

struct ConnectionStateView: View {
    var model: AppModel

    private var dotColor: Color {
        switch model.loadState {
        case .loading: return U.yellow
        case .error: return U.orangeAction
        case .ready: return U.green
        }
    }

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "wifi")
                .font(.system(size: 13, weight: .semibold))
            Text(model.serviceLabel)
                .font(.system(size: 12, weight: .semibold))
                .lineLimit(1)
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)
                .overlay(Circle().stroke(U.connectionDotRing, lineWidth: 2))
        }
        .foregroundStyle(U.headerState)
    }
}

// MARK: - 身份门厅

struct GatewayView: View {
    var model: AppModel

    var body: some View {
        ZStack {
            U.background.ignoresSafeArea()
            VStack(spacing: 0) {
                UrtorisHeader(model: model, title: "工作流双端入口", showsBack: false)
                ScrollView {
                    VStack(spacing: 0) {
                        frame
                        footer
                    }
                    .padding(.horizontal, Metrics.pagePadding)
                    .padding(.top, 24)
                    .padding(.bottom, 32)
                    .frame(maxWidth: Metrics.pageMaxWidth)
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }

    private var frame: some View {
        VStack(spacing: 0) {
            intro

            PortalChoice(
                tint: U.navy,
                background: U.paper,
                systemImage: nil,
                glyph: true,
                title: "创建工作流端",
                summary: "设计步骤、保存草稿，并发布可供调用的版本。",
                meta: creatorMeta,
                action: "进入创建端"
            ) {
                model.selectForEditing(model.workflows.first)
                model.portal = .creator
            }

            Hairline()

            PortalChoice(
                tint: U.orange,
                background: U.orange.opacity(0.09),
                systemImage: "bubble.left.and.bubble.right.fill",
                glyph: false,
                title: "使用工作流端",
                summary: "选择已发布版本装载给 Agent，对话并查看运行结果。",
                meta: consumerMeta,
                action: "进入使用端"
            ) {
                model.portal = .consumer
                Task { await model.loadConversations() }
            }

            Hairline()

            PortalChoice(
                tint: U.green,
                background: U.green.opacity(0.08),
                systemImage: "gamecontroller.fill",
                glyph: false,
                title: "使用机器人",
                summary: "在手机上看机器人画面，用方向盘或键盘遥控。",
                meta: "需要本机运行桥接服务，手机与电脑在同一网络",
                action: "进入机器人遥控台"
            ) {
                model.portal = .robot
            }
        }
        .background(U.paperBright)
        .clipShape(RoundedRectangle(cornerRadius: Radius.frame, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.frame, style: .continuous)
                .stroke(U.line, lineWidth: 1)
        )
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(U.paperBright.opacity(0.34), lineWidth: 1)
                    .frame(width: 52, height: 52)
                WorkflowGlyph(color: U.paperBright, lineWidth: 2.2)
                    .frame(width: 26, height: 26)
            }
            .padding(.bottom, 30)

            Text("选择你要进入的工作端")
                .font(.urtorisDisplay(38))
                .tracking(-1.4)
                .foregroundStyle(U.paper)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 260, alignment: .leading)

            Text("创建端负责编排和发布多个工作流，使用端选择已发布版本装载给 Agent 对话并查看执行结果。")
                .font(.urtorisBody(13))
                .lineSpacing(6)
                .foregroundStyle(U.paper.opacity(0.76))
                .padding(.top, 20)

            HStack(spacing: 9) {
                Circle().fill(U.green).frame(width: 8, height: 8)
                Text("两个端共享同一批已发布工作流")
                    .font(.system(size: 10))
                    .foregroundStyle(U.paper.opacity(0.76))
            }
            .padding(.top, 34)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(30)
        .background(U.navy)
    }

    @ViewBuilder
    private var footer: some View {
        if model.loadState == .error {
            VStack(spacing: 8) {
                Text("暂时无法连接工作流服务。")
                    .font(.system(size: 13))
                    .foregroundStyle(U.orangeAction)
                Button("重试连接") {
                    Task { await model.refresh() }
                }
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(U.orangeAction)
                if let detail = model.serviceError {
                    Text(detail)
                        .font(.system(size: 11))
                        .foregroundStyle(U.inkSoft)
                        .multilineTextAlignment(.center)
                }
                Text("当前服务地址：\(model.serviceURLText)")
                    .font(.urtorisLabel(10, weight: .semibold))
                    .foregroundStyle(U.inkSoft)
            }
            .padding(.top, 16)
        } else {
            Text("当前为功能原型，暂不需要账号密码。")
                .font(.system(size: 10))
                .foregroundStyle(U.inkSoft)
                .padding(.top, 18)
        }
    }

    private var creatorMeta: String {
        switch model.loadState {
        case .loading: return "正在读取工作流"
        case .error: return "暂时无法读取工作流"
        case .ready:
            if model.workflows.isEmpty { return "还没有工作流，进入创建端开始" }
            return "\(model.workflows.count) 个工作流 · \(model.publishedWorkflows.count) 个已发布"
        }
    }

    private var consumerMeta: String {
        switch model.loadState {
        case .loading: return "正在读取可用版本"
        case .error: return "暂时无法读取可用版本"
        case .ready:
            let count = model.publishedWorkflows.count
            return count > 0 ? "\(count) 个已发布版本可装载" : "正在等待首个发布版本"
        }
    }
}

private struct PortalChoice: View {
    var tint: Color
    var background: Color
    var systemImage: String?
    var glyph: Bool
    var title: String
    var summary: String
    var meta: String
    var action: String
    var onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 20) {
                ZStack {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(tint)
                        .frame(width: 48, height: 48)
                    if glyph {
                        WorkflowGlyph(color: .white, lineWidth: 2.2)
                            .frame(width: 23, height: 23)
                    } else if let systemImage {
                        Image(systemName: systemImage)
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                }

                VStack(alignment: .leading, spacing: 0) {
                    Text(title)
                        .font(.urtorisHeadline(26))
                        .tracking(-0.9)
                        .foregroundStyle(U.ink)
                    Text(summary)
                        .font(.urtorisBody(13))
                        .lineSpacing(5)
                        .foregroundStyle(U.inkSoft)
                        .padding(.top, 10)
                    Text(meta)
                        .font(.urtorisLabel(10, weight: .semibold))
                        .foregroundStyle(U.inkSoft)
                        .padding(.top, 12)
                    HStack(spacing: 8) {
                        Text(action)
                            .font(.system(size: 13, weight: .bold))
                        Image(systemName: "arrow.right")
                            .font(.system(size: 13, weight: .bold))
                    }
                    .foregroundStyle(U.navy)
                    .padding(.top, 16)
                }

                Spacer(minLength: 0)
            }
            .padding(26)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(background)
        }
        .buttonStyle(PressableStyle())
    }
}

/// 触屏上的按下反馈：同一色系内的小幅加深。
struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .overlay(configuration.isPressed ? U.navy.opacity(0.07) : Color.clear)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

#Preview {
    ContentView()
}
