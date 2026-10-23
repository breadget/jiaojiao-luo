import Foundation
import Observation

@MainActor
@Observable
final class AppModel {
    enum Portal: String, CaseIterable, Identifiable {
        case gateway, creator, consumer, robot

        var id: String { rawValue }

        var title: String {
            switch self {
            case .gateway: return "工作流双端入口"
            case .creator: return "创建工作流端"
            case .consumer: return "使用工作流端"
            case .robot: return "机器人遥控台"
            }
        }
    }

    enum LoadState: Equatable { case loading, ready, error }

    // 路由与连接
    var portal: Portal = .gateway
    var loadState: LoadState = .loading
    var serviceError: String?

    // 服务端数据
    var workflows: [WorkflowRecord] = []
    var runs: [WorkflowRun] = []
    var runPagination = RunPagination()

    // 使用端
    var conversations: [ConversationSummary] = []
    var activeConversationId: String?
    var chat: [ChatTurn] = []
    var chatDraft: String = ""
    var chatBusy = false
    var chatError: String?
    var consumerWorkflowId: String?
    var lastRun: WorkflowRun?
    var llmConfig = LlmConfig()
    var llmConfigured: Bool { !llmConfig.apiKey.isEmpty || !llmConfig.model.isEmpty }

    // 创建端
    var editingWorkflowId: String?
    var draftName: String = ""
    var draftDescription: String = ""
    var draftSteps: [WorkflowStep] = []
    var creatorBusy = false
    var creatorNotice: String?
    var creatorError: String?

    // 设置
    var serviceURLText: String = ""
    var adminToken: String = ""
    var apiToken: String = ""

    let isDemo: Bool
    /// 仅用于界面验收：-openFirstConversation 直接打开演示会话。
    private let opensFirstConversation: Bool
    private var api: UrtorisAPI
    private var engineSessionId: String?

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        let demo = arguments.contains("-demoMode")
        self.isDemo = demo
        self.opensFirstConversation = arguments.contains("-openFirstConversation")
        let stored = UserDefaults.standard.string(forKey: "urtoris.serviceURL") ?? ""
        var defaultURL = stored.isEmpty ? "http://localhost:3000" : stored
        // 仅用于验收与排障：-serviceURL https://example.com 临时指定服务端。
        if let index = arguments.firstIndex(of: "-serviceURL"),
           arguments.indices.contains(index + 1),
           !arguments[index + 1].isEmpty {
            defaultURL = arguments[index + 1]
        }
        self.serviceURLText = defaultURL
        self.api = UrtorisAPI(baseURL: URL(string: defaultURL) ?? URL(string: "http://localhost:3000")!)
        loadLlmConfig()
        loadTokens()
        // 仅用于界面验收：-startPortal consumer|creator|robot 直接进入某张工作台。
        if let index = arguments.firstIndex(of: "-startPortal"),
           arguments.indices.contains(index + 1),
           let portal = Portal(rawValue: arguments[index + 1]) {
            self.portal = portal
        }
    }

    // MARK: - 服务地址

    func applyServiceURL() {
        let trimmed = serviceURLText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme != nil else {
            serviceError = "服务地址需要包含 http:// 或 https://"
            loadState = .error
            return
        }
        api = UrtorisAPI(baseURL: url)
        api.adminToken = adminToken
        api.apiToken = apiToken
        UserDefaults.standard.set(trimmed, forKey: "urtoris.serviceURL")
        Task { await refresh() }
    }

    /// 公网部署用的访问令牌，只写进本机钥匙串。
    func applyTokens() {
        api.adminToken = adminToken
        api.apiToken = apiToken
        Keychain.write("urtoris.adminToken", adminToken)
        Keychain.write("urtoris.apiToken", apiToken)
    }

    private func loadTokens() {
        adminToken = Keychain.read("urtoris.adminToken") ?? ""
        apiToken = Keychain.read("urtoris.apiToken") ?? ""
        api.adminToken = adminToken
        api.apiToken = apiToken
    }

    var serviceLabel: String {
        switch loadState {
        case .loading: return "正在连接服务"
        case .error: return "服务不可用"
        case .ready: return isDemo ? "演示数据" : "已连接服务"
        }
    }

    // MARK: - 读取状态

    func refresh(runPage: Int = 0) async {
        if isDemo {
            workflows = DemoData.workflows
            runs = DemoData.runs
            runPagination = RunPagination(page: 0, hasPrevious: false, hasNext: false)
            conversations = DemoData.conversations
            loadState = .ready
            serviceError = nil
            if consumerWorkflowId == nil { consumerWorkflowId = workflows.first(where: \.isPublished)?.id }
            if editingWorkflowId == nil { selectForEditing(workflows.first) }
            if opensFirstConversation, chat.isEmpty, let first = conversations.first {
                await openConversation(first)
            }
            return
        }
        loadState = .loading
        do {
            let state = try await api.state(runPage: runPage)
            workflows = state.workflows
            runs = state.runs
            runPagination = state.runPagination
            loadState = .ready
            serviceError = nil
            if consumerWorkflowId == nil {
                consumerWorkflowId = workflows.first(where: \.isPublished)?.id
            }
            if editingWorkflowId == nil {
                selectForEditing(workflows.first)
            }
            // 直接从使用端进入时，会话列表要等工作流就位后再取一次。
            if portal == .consumer, conversations.isEmpty {
                await loadConversations()
            }
        } catch {
            loadState = .error
            serviceError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    var publishedWorkflows: [WorkflowRecord] { workflows.filter(\.isPublished) }
    var consumerWorkflow: WorkflowRecord? {
        workflows.first { $0.id == consumerWorkflowId }
    }
    var activeConversation: ConversationSummary? {
        conversations.first { $0.id == activeConversationId }
    }

    // MARK: - 使用端会话

    func selectConsumerWorkflow(_ id: String) async {
        consumerWorkflowId = id
        activeConversationId = nil
        chat = []
        engineSessionId = nil
        await loadConversations()
    }

    func loadConversations() async {
        guard let workflowId = consumerWorkflowId else { return }
        if isDemo {
            conversations = DemoData.conversations
            return
        }
        do {
            let response = try await api.consumerSession(workflowId: workflowId, sessionId: nil)
            conversations = response.conversations
            apply(session: response)
        } catch {
            // 首次没有会话时服务端会新建一个，这里保持安静，等用户发出第一条消息。
            chatError = nil
        }
    }

    func newConversation() async {
        guard let workflowId = consumerWorkflowId else {
            chatError = "先发布一个工作流"
            return
        }
        if isDemo {
            let now = Date().timeIntervalSince1970 * 1000
            let conversation = ConversationSummary(
                id: "cs_\(UUID().uuidString.prefix(6))", workflowId: workflowId,
                engineSessionId: "s_demo", title: "新对话", createdAt: now, updatedAt: now)
            conversations.insert(conversation, at: 0)
            activeConversationId = conversation.id
            chat = []
            return
        }
        do {
            let response = try await api.createConsumerSession(workflowId: workflowId)
            conversations = response.conversations
            activeConversationId = response.session.id
            engineSessionId = response.session.engineSessionId
            chat = []
        } catch {
            chatError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func openConversation(_ conversation: ConversationSummary) async {
        consumerWorkflowId = conversation.workflowId
        activeConversationId = conversation.id
        if isDemo {
            chat = DemoData.messages(for: conversation)
            return
        }
        do {
            let response = try await api.consumerSession(
                workflowId: conversation.workflowId, sessionId: conversation.id)
            conversations = response.conversations
            apply(session: response)
        } catch {
            chatError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func apply(session response: ConsumerSessionResponse) {
        activeConversationId = response.session.id
        engineSessionId = response.session.engineSessionId
        chat = response.messages.map { record in
            ChatTurn(
                id: record.id,
                role: record.role == "user" ? .user : .agent,
                text: record.text,
                at: record.createdAt,
                working: record.status == "working",
                failed: record.status == "failed"
            )
        }
    }

    func sendChatMessage() async {
        let text = chatDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !chatBusy else { return }
        guard let workflow = consumerWorkflow ?? publishedWorkflows.first else {
            chatError = "先发布一个工作流"
            return
        }
        chatError = nil
        chatBusy = true
        chatDraft = ""
        chat.append(ChatTurn(role: .user, text: text))
        let placeholder = ChatTurn(role: .agent, text: "", working: true)
        chat.append(placeholder)

        if isDemo {
            try? await Task.sleep(nanoseconds: 700_000_000)
            let response = DemoData.reply(to: text, workflow: workflow)
            finish(placeholderId: placeholder.id, response: response)
            chatBusy = false
            return
        }

        do {
            let response = try await api.chat(
                workflowId: workflow.id,
                message: text,
                sessionId: engineSessionId,
                consumerSessionId: activeConversationId,
                llm: llmConfig
            )
            finish(placeholderId: placeholder.id, response: response)
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            if let index = chat.firstIndex(where: { $0.id == placeholder.id }) {
                chat[index].working = false
                chat[index].failed = true
                chat[index].text = message
            }
            chatError = message
        }
        chatBusy = false
    }

    private func finish(placeholderId: String, response: AgentChatResponse) {
        if let index = chat.firstIndex(where: { $0.id == placeholderId }) {
            chat[index].working = false
            chat[index].text = response.reply
            chat[index].mode = response.mode
            chat[index].intent = response.intent
            chat[index].runId = response.run?.id
        }
        if let sessionId = response.sessionId { engineSessionId = sessionId }
        if let run = response.run {
            lastRun = run
            runs.insert(run, at: 0)
        }
        // AI 自动标题：首轮完成后更新左栏与页眉，失败时保留「新对话」。
        if let index = conversations.firstIndex(where: { $0.id == activeConversationId }),
           conversations[index].title == "新对话" {
            conversations[index].title = Self.title(from: response.reply)
        }
    }

    static func title(from text: String) -> String {
        let clean = text
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let prefix = String(clean.prefix(18))
        return prefix.isEmpty ? "新对话" : prefix
    }

    // MARK: - 创建端

    func selectForEditing(_ workflow: WorkflowRecord?) {
        guard let workflow else {
            editingWorkflowId = nil
            draftName = ""
            draftDescription = ""
            draftSteps = []
            return
        }
        editingWorkflowId = workflow.id
        draftName = workflow.name
        draftDescription = workflow.description
        draftSteps = workflow.draftSteps
    }

    var editingWorkflow: WorkflowRecord? {
        workflows.first { $0.id == editingWorkflowId }
    }

    func addWorkflow() async {
        if isDemo {
            let now = Date().timeIntervalSince1970 * 1000
            let created = WorkflowRecord(
                id: "wf_\(UUID().uuidString.prefix(6))", name: "未命名工作流", description: "",
                draftSteps: [WorkflowStep(title: "读入输入", detail: "描述这一步要拿到的输入。", kind: .input)],
                publishedSteps: nil, version: 1, hasUnpublishedChanges: true,
                createdAt: now, updatedAt: now, publishedAt: nil, n8nWebhookUrl: nil)
            workflows.append(created)
            selectForEditing(created)
            creatorNotice = "已新建工作流"
            return
        }
        creatorBusy = true
        defer { creatorBusy = false }
        do {
            let created = try await api.createWorkflow()
            workflows.append(created)
            selectForEditing(created)
            creatorNotice = "已新建工作流"
            creatorError = nil
        } catch {
            creatorError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func deleteEditingWorkflow() async {
        guard let id = editingWorkflowId else { return }
        if isDemo {
            workflows.removeAll { $0.id == id }
            selectForEditing(workflows.first)
            creatorNotice = "已删除工作流"
            return
        }
        creatorBusy = true
        defer { creatorBusy = false }
        do {
            try await api.deleteWorkflow(id: id)
            workflows.removeAll { $0.id == id }
            selectForEditing(workflows.first)
            creatorNotice = "已删除工作流"
            creatorError = nil
        } catch {
            creatorError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func saveEditingWorkflow(publish: Bool) async {
        guard let id = editingWorkflowId else { return }
        guard draftName.trimmingCharacters(in: .whitespaces).count >= 2 else {
            creatorError = "工作流名称至少 2 个字"
            return
        }
        guard (1...12).contains(draftSteps.count) else {
            creatorError = "有效步骤需要 1–12 个"
            return
        }
        creatorBusy = true
        defer { creatorBusy = false }
        if isDemo {
            guard let index = workflows.firstIndex(where: { $0.id == id }) else { return }
            workflows[index].name = draftName
            workflows[index].description = draftDescription
            workflows[index].draftSteps = draftSteps
            workflows[index].hasUnpublishedChanges = !publish
            if publish {
                workflows[index].publishedSteps = draftSteps
                workflows[index].version += 1
                workflows[index].publishedAt = Date().timeIntervalSince1970 * 1000
            }
            creatorNotice = publish ? "已发布 v\(workflows[index].version)" : "草稿已保存"
            return
        }
        do {
            let updated = try await api.saveWorkflow(
                id: id, name: draftName, description: draftDescription,
                steps: draftSteps, publish: publish)
            if let index = workflows.firstIndex(where: { $0.id == id }) {
                workflows[index] = updated
            }
            selectForEditing(updated)
            creatorNotice = publish ? "已发布 v\(updated.version)" : "草稿已保存"
            creatorError = nil
        } catch {
            creatorError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func moveStep(from source: IndexSet, to destination: Int) {
        draftSteps.move(fromOffsets: source, toOffset: destination)
    }

    // MARK: - 本地模型配置

    func loadLlmConfig() {
        let defaults = UserDefaults.standard
        llmConfig.provider = defaults.string(forKey: "urtoris.llm.provider") ?? "openai"
        llmConfig.baseUrl = defaults.string(forKey: "urtoris.llm.baseUrl") ?? ""
        llmConfig.model = defaults.string(forKey: "urtoris.llm.model") ?? ""
        llmConfig.reasoningEffort = defaults.string(forKey: "urtoris.llm.effort") ?? "medium"
        llmConfig.apiKey = Keychain.read("urtoris.llm.apiKey") ?? ""
    }

    func saveLlmConfig() {
        let defaults = UserDefaults.standard
        defaults.set(llmConfig.provider, forKey: "urtoris.llm.provider")
        defaults.set(llmConfig.baseUrl, forKey: "urtoris.llm.baseUrl")
        defaults.set(llmConfig.model, forKey: "urtoris.llm.model")
        defaults.set(llmConfig.reasoningEffort, forKey: "urtoris.llm.effort")
        Keychain.write("urtoris.llm.apiKey", llmConfig.apiKey)
    }
}
