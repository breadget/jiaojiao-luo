import SwiftUI

/// 使用端：安静的深色对话工作台。
/// 首屏只有会话导航、一个短问题和可输入的输入容器；执行证据按需展开。
struct ConsumerView: View {
    var model: AppModel

    @State private var showConversations = false
    @State private var showRunPanel = false
    @State private var showSettings = false
    @FocusState private var composerFocused: Bool

    private let composerBackground = Color(hex: 0x292A2E)

    var body: some View {
        ZStack {
            U.consumerBackground.ignoresSafeArea()
            VStack(spacing: 0) {
                topBar
                chatStream
                composer
            }
        }
        .preferredColorScheme(.dark)
        .task {
            // 进入使用端就取一次会话与聊天记录，和 Web 端装载时一致。
            await model.loadConversations()
        }
        .sheet(isPresented: $showConversations) {
            ConversationSheet(model: model, isPresented: $showConversations)
        }
        .sheet(isPresented: $showRunPanel) {
            RunPanelView(model: model, isPresented: $showRunPanel)
        }
        .sheet(isPresented: $showSettings) {
            ConsumerSettingsSheet(model: model, isPresented: $showSettings)
        }
    }

    // MARK: - 会话标题栏

    private var topBar: some View {
        HStack(spacing: 12) {
            Button {
                showConversations = true
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "sidebar.left")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(U.consumerMuted)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.activeConversation?.title ?? "新对话")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(U.consumerText)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Text(model.consumerWorkflow?.name ?? "未选择工作流")
                            .font(.system(size: 12))
                            .foregroundStyle(U.consumerFaint)
                            .lineLimit(1)
                    }
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(U.consumerFaint)
                }
            }
            .buttonStyle(.plain)

            Spacer(minLength: 8)

            runtimeChip

            Button {
                showRunPanel = true
            } label: {
                Image(systemName: "sidebar.right")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(model.lastRun == nil ? U.consumerFaint : U.consumerMuted)
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)
            .disabled(model.lastRun == nil)

            Button {
                model.portal = .gateway
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(U.consumerMuted)
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .frame(height: 64)
        .background(U.consumerBackground)
        .overlay(alignment: .bottom) { Hairline(color: U.consumerLine) }
    }

    private var runtimeChip: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(model.chatBusy ? U.yellow : (model.loadState == .error ? U.orangeAction : U.green))
                .frame(width: 7, height: 7)
            Text(runtimeLabel)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(U.consumerMuted)
        }
    }

    private var runtimeLabel: String {
        if model.chatBusy { return "处理中" }
        if model.loadState == .error { return "离线" }
        if model.isDemo { return "演示" }
        return model.llmConfigured ? model.llmConfig.providerLabel : "模拟"
    }

    // MARK: - 对话流

    private var chatStream: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if model.chat.isEmpty {
                    emptyState
                        .frame(maxWidth: .infinity)
                        .padding(.top, 80)
                } else {
                    VStack(alignment: .leading, spacing: 30) {
                        ForEach(model.chat) { turn in
                            ChatTurnView(turn: turn)
                                .id(turn.id)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 24)
                    .padding(.bottom, 18)
                    .frame(maxWidth: Metrics.consumerStreamMaxWidth)
                    .frame(maxWidth: .infinity)
                }
            }
            .onChange(of: model.chat.count) {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 18) {
            ZStack {
                Circle().fill(U.consumerRaised).frame(width: 52, height: 52)
                WorkflowGlyph(color: U.consumerMuted, lineWidth: 2)
                    .frame(width: 24, height: 24)
            }
            Text("想从哪里开始？")
                .font(.system(size: 26, weight: .semibold))
                .tracking(-0.6)
                .foregroundStyle(U.consumerText)
            if model.publishedWorkflows.isEmpty {
                Text("先在创建端发布一个工作流，再回到这里装载给 Agent。")
                    .font(.system(size: 13))
                    .foregroundStyle(U.consumerFaint)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, 24)
    }

    // MARK: - 输入容器

    private var composer: some View {
        VStack(spacing: 10) {
            if let error = model.chatError {
                Text(error)
                    .font(.system(size: 12))
                    .foregroundStyle(Color(hex: 0xE5786F))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            TextField(composerPlaceholder, text: Binding(
                get: { model.chatDraft },
                set: { model.chatDraft = $0 }
            ), axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 14))
                .foregroundStyle(U.consumerText)
                .lineLimit(1...8)
                .focused($composerFocused)
                .disabled(model.publishedWorkflows.isEmpty || model.chatBusy)
                .padding(.horizontal, 2)

            HStack(spacing: 10) {
                Menu {
                    Section("工作流") {
                        ForEach(model.publishedWorkflows) { workflow in
                            Button {
                                Task { await model.selectConsumerWorkflow(workflow.id) }
                            } label: {
                                Label(
                                    "\(workflow.name) · v\(workflow.version)",
                                    systemImage: workflow.id == model.consumerWorkflowId
                                        ? "checkmark" : "square.stack"
                                )
                            }
                        }
                    }
                    Section("对话") {
                        Button {
                            Task { await model.newConversation() }
                        } label: {
                            Label("新对话", systemImage: "square.and.pencil")
                        }
                        Button {
                            showConversations = true
                        } label: {
                            Label("聊天记录", systemImage: "clock")
                        }
                    }
                    Section {
                        Button {
                            showSettings = true
                        } label: {
                            Label("设置", systemImage: "key")
                        }
                    }
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(U.consumerMuted)
                        .frame(width: 38, height: 38)
                        .overlay(Circle().stroke(U.consumerLine, lineWidth: 1))
                }
                .disabled(model.publishedWorkflows.isEmpty || model.chatBusy)

                Spacer(minLength: 0)

                if model.chatBusy {
                    ProgressView()
                        .controlSize(.small)
                        .tint(U.consumerMuted)
                }

                Button {
                    Task { await model.sendChatMessage() }
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(canSend ? U.consumerOnAction : U.consumerFaint)
                        .frame(width: 38, height: 38)
                        .background(canSend ? U.consumerAction : U.consumerRaised, in: Circle())
                }
                .disabled(!canSend)
            }
        }
        .padding(12)
        .frame(maxWidth: Metrics.consumerComposerMaxWidth)
        .background(composerBackground, in: RoundedRectangle(cornerRadius: Radius.surface, style: .continuous))
        .softShadow(0.35, radius: 18, y: 8)
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity)
    }

    private var composerPlaceholder: String {
        model.publishedWorkflows.isEmpty ? "先发布一个工作流" : "描述你想完成的事"
    }

    private var canSend: Bool {
        !model.chatDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !model.chatBusy
            && !model.publishedWorkflows.isEmpty
    }
}

// MARK: - 一轮对话

struct ChatTurnView: View {
    var turn: ChatTurn

    var body: some View {
        switch turn.role {
        case .agent:
            HStack(alignment: .top, spacing: 12) {
                ZStack {
                    Circle().fill(U.navy).frame(width: 30, height: 30)
                    WorkflowGlyph(color: .white, lineWidth: 2.4)
                        .frame(width: 15, height: 15)
                }
                VStack(alignment: .leading, spacing: 8) {
                    if turn.working {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small).tint(U.consumerMuted)
                            Text("正在按工作流处理…")
                                .font(.system(size: 14))
                                .foregroundStyle(U.consumerMuted)
                        }
                    } else {
                        Text(turn.text)
                            .font(.system(size: 14))
                            .lineSpacing(8)
                            .foregroundStyle(turn.failed ? Color(hex: 0xE5786F) : U.consumerText)
                            .textSelection(.enabled)
                    }
                    if let mode = turn.mode, !turn.working {
                        HStack(spacing: 6) {
                            Text(turn.intent ?? "回复")
                            Text("·")
                            Text(modeLabel(mode))
                            if let runId = turn.runId {
                                Text("·")
                                Text(runId)
                            }
                        }
                        .font(.urtorisLabel(10, weight: .semibold))
                        .foregroundStyle(U.consumerFaint)
                    }
                }
                Spacer(minLength: 16)
            }
        case .user:
            HStack(alignment: .top, spacing: 12) {
                Spacer(minLength: 40)
                Text(turn.text)
                    .font(.system(size: 14))
                    .lineSpacing(8)
                    .foregroundStyle(U.consumerText)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(U.consumerRaised)
                    .clipShape(UnevenRoundedRectangle(
                        topLeadingRadius: Radius.surface,
                        bottomLeadingRadius: Radius.surface,
                        bottomTrailingRadius: 4,
                        topTrailingRadius: Radius.surface,
                        style: .continuous
                    ))
            }
        }
    }

    private func modeLabel(_ mode: String) -> String {
        switch mode {
        case "model": return "真实模型"
        case "n8n": return "n8n"
        default: return "内置模拟"
        }
    }
}

// MARK: - 会话导航

struct ConversationSheet: View {
    var model: AppModel
    @Binding var isPresented: Bool

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        Task {
                            await model.newConversation()
                            isPresented = false
                        }
                    } label: {
                        Label("新对话", systemImage: "square.and.pencil")
                            .font(.system(size: 15, weight: .semibold))
                    }
                    Button {
                        model.portal = .gateway
                        isPresented = false
                    } label: {
                        Label("切换工作端", systemImage: "chevron.left")
                    }
                }
                Section("聊天记录") {
                    if model.conversations.isEmpty {
                        Text("还没有聊天记录")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(model.conversations) { conversation in
                        Button {
                            Task {
                                await model.openConversation(conversation)
                                isPresented = false
                            }
                        } label: {
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(conversation.title)
                                        .font(.system(size: 15, weight: .medium))
                                        .lineLimit(1)
                                        .foregroundStyle(.primary)
                                    Text(relativeAge(conversation.updatedAt))
                                        .font(.system(size: 12))
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if conversation.id == model.activeConversationId {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(.tint)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("使用工作流端")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { isPresented = false }
                }
            }
        }
    }

    private func relativeAge(_ timestamp: Double) -> String {
        let seconds = max(Date().timeIntervalSince1970 - timestamp / 1000, 0)
        if seconds < 60 { return "刚刚" }
        if seconds < 3600 { return "\(Int(seconds / 60)) 分钟前" }
        if seconds < 86_400 { return "\(Int(seconds / 3600)) 小时前" }
        return "\(Int(seconds / 86_400)) 天前"
    }
}

// MARK: - 执行详情（默认收起）

struct RunPanelView: View {
    var model: AppModel
    @Binding var isPresented: Bool
    @State private var tab = 0

    private var run: WorkflowRun? { model.lastRun }

    var body: some View {
        NavigationStack {
            Group {
                if let run {
                    VStack(spacing: 0) {
                        Picker("", selection: $tab) {
                            Text("路线").tag(0)
                            Text("日志").tag(1)
                            Text("结果").tag(2)
                        }
                        .pickerStyle(.segmented)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)

                        ScrollView {
                            VStack(alignment: .leading, spacing: 18) {
                                if tab == 0 { route(run) }
                                if tab == 1 { logs(run) }
                                if tab == 2 { result(run) }
                            }
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                } else {
                    ContentUnavailableView(
                        "还没有运行记录",
                        systemImage: "list.bullet.rectangle",
                        description: Text("在使用端发一条消息，运行证据会出现在这里。")
                    )
                }
            }
            .navigationTitle("执行详情")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { isPresented = false }
                }
            }
        }
    }

    private func route(_ run: WorkflowRun) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            infoRow("工作流", "\(run.workflowName) · v\(run.workflowVersion)")
            infoRow("状态", run.status.label)
            infoRow("引擎", engineLabel(run.engine))
            if let requestId = run.requestId { infoRow("requestId", requestId) }
            if let executionId = run.executionId { infoRow("executionId", executionId) }
            if let error = run.errorMessage { infoRow("错误", error) }

            Text("步骤")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.top, 6)

            ForEach(Array(run.steps.enumerated()), id: \.element.id) { index, step in
                HStack(alignment: .top, spacing: 12) {
                    Text("\(index + 1)")
                        .font(.urtorisLabel(11, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 24, height: 24)
                        .background(
                            stepKindColor(step.kind),
                            in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                        )
                    VStack(alignment: .leading, spacing: 3) {
                        Text(step.title)
                            .font(.system(size: 14, weight: .semibold))
                        Text(step.detail)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                        Text(step.kind.label)
                            .font(.urtorisLabel(10, weight: .semibold))
                            .foregroundStyle(stepKindColor(step.kind))
                    }
                    Spacer()
                }
            }
        }
    }

    private func logs(_ run: WorkflowRun) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if run.logs.isEmpty {
                Text("这次运行没有返回日志。")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
            }
            ForEach(run.logs) { log in
                HStack(alignment: .top, spacing: 10) {
                    Text(clock(log.at))
                        .font(.urtorisLabel(10, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Text(log.message)
                        .font(.system(size: 13))
                        .foregroundStyle(logColor(log.level))
                    Spacer()
                }
            }
        }
    }

    private func result(_ run: WorkflowRun) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            infoRow("摘要", run.output.summary)
            infoRow("处理数量", Fmt.number(run.output.processed))
            Text(run.output.result)
                .font(.system(size: 14))
                .lineSpacing(6)
                .textSelection(.enabled)
        }
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.urtorisLabel(10, weight: .semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 14))
                .textSelection(.enabled)
        }
    }

    private func engineLabel(_ engine: String?) -> String {
        switch engine {
        case "n8n": return "n8n"
        case "model": return "使用端模型"
        default: return "内置模拟器"
        }
    }

    private func logColor(_ level: String) -> Color {
        switch level {
        case "error": return U.orangeAction
        case "success": return U.green
        case "system": return .secondary
        default: return .primary
        }
    }

    private func clock(_ timestamp: Double) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: Date(timeIntervalSince1970: timestamp / 1000))
    }
}

func stepKindColor(_ kind: StepKind) -> Color {
    switch kind {
    case .input: return Color(hex: 0x4EA8DE)
    case .transform: return Color(hex: 0xA78BFA)
    case .decision: return Color(hex: 0xEDC94A)
    case .compose: return Color(hex: 0x34D399)
    case .output: return Color(hex: 0xFF6B35)
    }
}
