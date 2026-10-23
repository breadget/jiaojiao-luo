import Foundation

// MARK: - 宽容解码

extension KeyedDecodingContainer {
    /// 服务端字段增删时不让整页解析失败：缺失或类型不符都退回默认值。
    func soft<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        if let value = try? decodeIfPresent(T.self, forKey: key) { return value }
        if T.self == Bool.self,
           let int = try? decodeIfPresent(Int.self, forKey: key) {
            return (int != 0) as? T ?? fallback
        }
        if T.self == Int.self,
           let double = try? decodeIfPresent(Double.self, forKey: key) {
            return Int(double) as? T ?? fallback
        }
        if T.self == Double.self,
           let int = try? decodeIfPresent(Int.self, forKey: key) {
            return Double(int) as? T ?? fallback
        }
        return fallback
    }

    func softOptional<T: Decodable>(_ key: Key) -> T? {
        try? decodeIfPresent(T.self, forKey: key)
    }
}

// MARK: - 工作流

enum StepKind: String, Codable, CaseIterable, Identifiable {
    case input
    case transform
    case decision
    case compose
    case output

    var id: String { rawValue }

    var label: String {
        switch self {
        case .input: return "输入"
        case .transform: return "变换"
        case .decision: return "判断"
        case .compose: return "组合"
        case .output: return "输出"
        }
    }
}

struct WorkflowStep: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString
    var title: String = ""
    var detail: String = ""
    var kind: StepKind = .input

    enum CodingKeys: String, CodingKey { case id, title, detail, kind }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.soft(.id, UUID().uuidString)
        title = c.soft(.title, "")
        detail = c.soft(.detail, "")
        kind = c.soft(.kind, StepKind.input)
    }

    init(id: String = UUID().uuidString, title: String, detail: String, kind: StepKind) {
        self.id = id
        self.title = title
        self.detail = detail
        self.kind = kind
    }
}

struct WorkflowRecord: Codable, Identifiable, Equatable {
    var id: String = ""
    var name: String = ""
    var description: String = ""
    var draftSteps: [WorkflowStep] = []
    var publishedSteps: [WorkflowStep]?
    var version: Int = 1
    var hasUnpublishedChanges: Bool = false
    var createdAt: Double = 0
    var updatedAt: Double = 0
    var publishedAt: Double?
    var n8nWebhookUrl: String?

    var isPublished: Bool { (publishedSteps?.isEmpty == false) }
    var stepCount: Int { publishedSteps?.count ?? draftSteps.count }

    enum CodingKeys: String, CodingKey {
        case id, name, description, draftSteps, publishedSteps, version
        case hasUnpublishedChanges, createdAt, updatedAt, publishedAt, n8nWebhookUrl
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.soft(.id, "")
        name = c.soft(.name, "")
        description = c.soft(.description, "")
        draftSteps = c.soft(.draftSteps, [])
        publishedSteps = c.softOptional(.publishedSteps)
        version = c.soft(.version, 1)
        hasUnpublishedChanges = c.soft(.hasUnpublishedChanges, false)
        createdAt = c.soft(.createdAt, 0)
        updatedAt = c.soft(.updatedAt, 0)
        publishedAt = c.softOptional(.publishedAt)
        n8nWebhookUrl = c.softOptional(.n8nWebhookUrl)
    }

    init(
        id: String, name: String, description: String, draftSteps: [WorkflowStep],
        publishedSteps: [WorkflowStep]?, version: Int, hasUnpublishedChanges: Bool,
        createdAt: Double, updatedAt: Double, publishedAt: Double?, n8nWebhookUrl: String?
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.draftSteps = draftSteps
        self.publishedSteps = publishedSteps
        self.version = version
        self.hasUnpublishedChanges = hasUnpublishedChanges
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.publishedAt = publishedAt
        self.n8nWebhookUrl = n8nWebhookUrl
    }
}

// MARK: - 运行

enum RunStatus: String, Codable {
    case queued, running, completed, failed

    var label: String {
        switch self {
        case .queued: return "排队中"
        case .running: return "运行中"
        case .completed: return "已完成"
        case .failed: return "已失败"
        }
    }
}

struct RunLog: Codable, Identifiable, Equatable {
    var at: Double = 0
    var level: String = "info"
    var message: String = ""
    var stepId: String?

    var id: String { "\(at)-\(message.hashValue)" }

    enum CodingKeys: String, CodingKey { case at, level, message, stepId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = c.soft(.at, 0)
        level = c.soft(.level, "info")
        message = c.soft(.message, "")
        stepId = c.softOptional(.stepId)
    }

    init(at: Double, level: String, message: String, stepId: String? = nil) {
        self.at = at
        self.level = level
        self.message = message
        self.stepId = stepId
    }
}

struct RunOutput: Codable, Equatable {
    var summary: String = ""
    var processed: Double = 0
    var result: String = ""

    enum CodingKeys: String, CodingKey { case summary, processed, result }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        summary = c.soft(.summary, "")
        processed = c.soft(.processed, 0)
        result = c.soft(.result, "")
    }

    init(summary: String, processed: Double, result: String) {
        self.summary = summary
        self.processed = processed
        self.result = result
    }
}

struct WorkflowRun: Codable, Identifiable, Equatable {
    var id: String = ""
    var workflowId: String = ""
    var workflowName: String = ""
    var workflowVersion: Int = 1
    var status: RunStatus = .completed
    var steps: [WorkflowStep] = []
    var logs: [RunLog] = []
    var output: RunOutput = RunOutput(summary: "", processed: 0, result: "")
    var startedAt: Double = 0
    var finishedAt: Double?
    var engine: String?
    var requestId: String?
    var sessionId: String?
    var errorMessage: String?
    var executionId: String?
    var mode: String?
    var degraded: Bool?

    enum CodingKeys: String, CodingKey {
        case id, workflowId, workflowName, workflowVersion, status, steps, logs, output
        case startedAt, finishedAt, engine, requestId, sessionId, errorMessage, executionId, mode, degraded
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.soft(.id, "")
        workflowId = c.soft(.workflowId, "")
        workflowName = c.soft(.workflowName, "")
        workflowVersion = c.soft(.workflowVersion, 1)
        status = c.soft(.status, RunStatus.completed)
        steps = c.soft(.steps, [])
        logs = c.soft(.logs, [])
        output = c.soft(.output, RunOutput(summary: "", processed: 0, result: ""))
        startedAt = c.soft(.startedAt, 0)
        finishedAt = c.softOptional(.finishedAt)
        engine = c.softOptional(.engine)
        requestId = c.softOptional(.requestId)
        sessionId = c.softOptional(.sessionId)
        errorMessage = c.softOptional(.errorMessage)
        executionId = c.softOptional(.executionId)
        mode = c.softOptional(.mode)
        degraded = c.softOptional(.degraded)
    }

    init(
        id: String, workflowId: String, workflowName: String, workflowVersion: Int,
        status: RunStatus, steps: [WorkflowStep], logs: [RunLog], output: RunOutput,
        startedAt: Double, finishedAt: Double?, engine: String?, requestId: String? = nil,
        sessionId: String? = nil, errorMessage: String? = nil, executionId: String? = nil,
        mode: String? = nil, degraded: Bool? = nil
    ) {
        self.id = id
        self.workflowId = workflowId
        self.workflowName = workflowName
        self.workflowVersion = workflowVersion
        self.status = status
        self.steps = steps
        self.logs = logs
        self.output = output
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.engine = engine
        self.requestId = requestId
        self.sessionId = sessionId
        self.errorMessage = errorMessage
        self.executionId = executionId
        self.mode = mode
        self.degraded = degraded
    }
}

struct RunPagination: Codable, Equatable {
    var page: Int = 0
    var hasPrevious: Bool = false
    var hasNext: Bool = false

    enum CodingKeys: String, CodingKey { case page, hasPrevious, hasNext }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        page = c.soft(.page, 0)
        hasPrevious = c.soft(.hasPrevious, false)
        hasNext = c.soft(.hasNext, false)
    }

    init(page: Int = 0, hasPrevious: Bool = false, hasNext: Bool = false) {
        self.page = page
        self.hasPrevious = hasPrevious
        self.hasNext = hasNext
    }
}

struct StateResponse: Codable {
    var workflows: [WorkflowRecord] = []
    var runs: [WorkflowRun] = []
    var runPagination: RunPagination = RunPagination()
    var adminTrusted: Bool = false

    enum CodingKeys: String, CodingKey { case workflows, runs, runPagination, adminTrusted }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workflows = c.soft(.workflows, [])
        runs = c.soft(.runs, [])
        runPagination = c.soft(.runPagination, RunPagination())
        adminTrusted = c.soft(.adminTrusted, false)
    }

    init(
        workflows: [WorkflowRecord] = [], runs: [WorkflowRun] = [],
        runPagination: RunPagination = RunPagination(), adminTrusted: Bool = false
    ) {
        self.workflows = workflows
        self.runs = runs
        self.runPagination = runPagination
        self.adminTrusted = adminTrusted
    }
}

// MARK: - 使用端会话

struct ConversationSummary: Codable, Identifiable, Equatable {
    var id: String = ""
    var workflowId: String = ""
    var engineSessionId: String = ""
    var title: String = "新对话"
    var createdAt: Double = 0
    var updatedAt: Double = 0

    enum CodingKeys: String, CodingKey {
        case id, workflowId, engineSessionId, title, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.soft(.id, "")
        workflowId = c.soft(.workflowId, "")
        engineSessionId = c.soft(.engineSessionId, "")
        title = c.soft(.title, "新对话")
        createdAt = c.soft(.createdAt, 0)
        updatedAt = c.soft(.updatedAt, 0)
    }

    init(
        id: String, workflowId: String, engineSessionId: String, title: String,
        createdAt: Double, updatedAt: Double
    ) {
        self.id = id
        self.workflowId = workflowId
        self.engineSessionId = engineSessionId
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

struct ConsumerMessageRecord: Codable, Identifiable, Equatable {
    var id: String = ""
    var sessionId: String = ""
    var role: String = "agent"
    var status: String = "completed"
    var text: String = ""
    var createdAt: Double = 0
    var updatedAt: Double = 0

    enum CodingKeys: String, CodingKey {
        case id, sessionId, role, status, text, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.soft(.id, "")
        sessionId = c.soft(.sessionId, "")
        role = c.soft(.role, "agent")
        status = c.soft(.status, "completed")
        text = c.soft(.text, "")
        createdAt = c.soft(.createdAt, 0)
        updatedAt = c.soft(.updatedAt, 0)
    }

    init(
        id: String, sessionId: String, role: String, status: String, text: String,
        createdAt: Double, updatedAt: Double
    ) {
        self.id = id
        self.sessionId = sessionId
        self.role = role
        self.status = status
        self.text = text
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

struct ConsumerSessionResponse: Codable {
    var session: ConversationSummary
    var conversations: [ConversationSummary] = []
    var messages: [ConsumerMessageRecord] = []

    enum CodingKeys: String, CodingKey { case session, conversations, messages }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        session = c.soft(.session, ConversationSummary(
            id: "", workflowId: "", engineSessionId: "", title: "新对话",
            createdAt: 0, updatedAt: 0))
        conversations = c.soft(.conversations, [])
        messages = c.soft(.messages, [])
    }
}

/// 使用端一轮对话（本地渲染用，形状对齐 ChatTurn）。
struct ChatTurn: Identifiable, Equatable {
    enum Role: String { case user, agent }

    var id: String = UUID().uuidString
    var role: Role = .agent
    var text: String = ""
    var at: Double = Date().timeIntervalSince1970 * 1000
    var working: Bool = false
    var failed: Bool = false
    var mode: String?
    var intent: String?
    var runId: String?
    var attachments: [ChatAttachment] = []

    init(
        id: String = UUID().uuidString, role: Role, text: String,
        at: Double = Date().timeIntervalSince1970 * 1000, working: Bool = false,
        failed: Bool = false, mode: String? = nil, intent: String? = nil,
        runId: String? = nil, attachments: [ChatAttachment] = []
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.at = at
        self.working = working
        self.failed = failed
        self.mode = mode
        self.intent = intent
        self.runId = runId
        self.attachments = attachments
    }
}

struct ChatAttachment: Identifiable, Equatable {
    var id: String = UUID().uuidString
    var name: String = ""
    var size: Double = 0
    var mimeType: String = ""
}

/// 使用端自带的大模型配置，只留在设备上，不下发到服务端存储。
struct LlmConfig: Equatable {
    var provider: String = "openai"
    var apiKey: String = ""
    var baseUrl: String = ""
    var model: String = ""
    var reasoningEffort: String = "medium"

    static let providers: [(id: String, label: String, defaultModel: String, defaultBaseUrl: String)] = [
        ("openai", "OpenAI", "gpt-4o-mini", "https://api.openai.com/v1"),
        ("deepseek", "DeepSeek", "deepseek-chat", "https://api.deepseek.com"),
        ("anthropic", "Anthropic", "claude-3-5-sonnet-latest", "https://api.anthropic.com"),
        ("custom", "自定义", "", ""),
    ]

    var providerLabel: String {
        LlmConfig.providers.first { $0.id == provider }?.label ?? provider
    }
}

struct AgentChatResponse: Codable {
    var reply: String = ""
    var intent: String = ""
    var priority: String = "中"
    var keywords: [String] = []
    var run: WorkflowRun?
    var mode: String = "simulated"
    var executionMode: String?
    var degraded: Bool?
    var model: String?
    var sessionId: String?
    var requestId: String?
    var errorCode: String?

    enum CodingKeys: String, CodingKey {
        case reply, intent, priority, keywords, run, mode, executionMode, degraded
        case model, sessionId, requestId, errorCode
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reply = c.soft(.reply, "")
        intent = c.soft(.intent, "")
        priority = c.soft(.priority, "中")
        keywords = c.soft(.keywords, [])
        run = c.softOptional(.run)
        mode = c.soft(.mode, "simulated")
        executionMode = c.softOptional(.executionMode)
        degraded = c.softOptional(.degraded)
        model = c.softOptional(.model)
        sessionId = c.softOptional(.sessionId)
        requestId = c.softOptional(.requestId)
        errorCode = c.softOptional(.errorCode)
    }

    init(
        reply: String = "", intent: String = "", priority: String = "中",
        keywords: [String] = [], run: WorkflowRun? = nil, mode: String = "simulated",
        executionMode: String? = nil, degraded: Bool? = nil, model: String? = nil,
        sessionId: String? = nil, requestId: String? = nil, errorCode: String? = nil
    ) {
        self.reply = reply
        self.intent = intent
        self.priority = priority
        self.keywords = keywords
        self.run = run
        self.mode = mode
        self.executionMode = executionMode
        self.degraded = degraded
        self.model = model
        self.sessionId = sessionId
        self.requestId = requestId
        self.errorCode = errorCode
    }
}
