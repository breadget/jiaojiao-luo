import Foundation

enum APIError: LocalizedError {
    case message(String)
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .message(let m), .transport(let m): return m
        }
    }
}

/// 对接仓库里的 Next.js 路由（`app/api/**`）。默认指向本机开发服务器，
/// 因此手机上运行的 App 与浏览器看到的是同一批工作流与运行记录。
struct UrtorisAPI {
    var baseURL: URL
    /// 公网部署时才需要：对应服务端的 URTORIS_ADMIN_TOKEN / URTORIS_API_TOKEN。
    var adminToken: String = ""
    var apiToken: String = ""
    private let session: URLSession

    /// 请求需要哪一种访问边界。服务端规则见 lib/server/security.ts：
    ///  · plain     —— 只读接口，本机 / 内网可直接访问
    ///  · admin     —— /api/workflows 的写操作，公网必须带管理员令牌
    ///  · execution —— /api/agent/chat 与使用端会话，公网必须带 API 令牌
    enum Access { case plain, admin, execution }

    init(baseURL: URL) {
        self.baseURL = baseURL
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = HTTPCookieStorage.shared
        config.httpShouldSetCookies = true
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 60
        config.waitsForConnectivity = true
        self.session = URLSession(configuration: config)
    }

    struct ErrorEnvelope: Decodable { var error: String? }

    private func url(_ path: String, query: [URLQueryItem] = []) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.transport("服务地址无效")
        }
        var base = components.path
        if base.hasSuffix("/") { base.removeLast() }
        components.path = base + path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw APIError.transport("请求地址无效") }
        return url
    }

    private func send(
        _ path: String,
        method: String = "GET",
        query: [URLQueryItem] = [],
        body: [String: Any]? = nil,
        access: Access = .plain
    ) async throws -> Data {
        var request = URLRequest(url: try url(path, query: query))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // 原生客户端不带 Origin，会被服务端按"无来源调用"要求令牌。
        // 这里显式声明为与服务端同源的调用方，与浏览器同源请求等价。
        request.setValue(origin, forHTTPHeaderField: "Origin")
        if access == .execution {
            // 使用端路由显式开放给非浏览器客户端（见 consumer/session 的注释）。
            request.setValue("1", forHTTPHeaderField: "X-Urtoris-Consumer-Client")
        }
        let token = access == .admin ? adminToken : (access == .execution ? apiToken : "")
        if !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport("连不上工作流服务，请确认服务已启动且地址正确")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
            throw APIError.message(envelope?.error ?? "请求失败（HTTP \(status)）")
        }
        return data
    }

    /// 与服务端同源的 Origin：scheme://host[:port]。
    private var origin: String {
        guard let scheme = baseURL.scheme, let host = baseURL.host else { return "" }
        if let port = baseURL.port,
           !(scheme == "http" && port == 80),
           !(scheme == "https" && port == 443) {
            return "\(scheme)://\(host):\(port)"
        }
        return "\(scheme)://\(host)"
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.message("返回数据无法解析")
        }
    }

    private struct WorkflowEnvelope: Decodable { var workflow: WorkflowRecord }

    // MARK: - 状态

    func state(runPage: Int = 0) async throws -> StateResponse {
        let data = try await send("/api/state", query: [URLQueryItem(name: "runPage", value: String(runPage))])
        return try decode(StateResponse.self, from: data)
    }

    // MARK: - 工作流

    @discardableResult
    func createWorkflow() async throws -> WorkflowRecord {
        let data = try await send(
            "/api/workflows", method: "POST", body: ["action": "create"], access: .admin)
        return try decode(WorkflowEnvelope.self, from: data).workflow
    }

    @discardableResult
    func saveWorkflow(
        id: String,
        name: String,
        description: String,
        steps: [WorkflowStep],
        publish: Bool
    ) async throws -> WorkflowRecord {
        let body: [String: Any] = [
            "id": id,
            "name": name,
            "description": description,
            "action": publish ? "publish" : "save",
            "steps": steps.map { ["id": $0.id, "title": $0.title, "detail": $0.detail, "kind": $0.kind.rawValue] },
        ]
        let data = try await send("/api/workflows", method: "POST", body: body, access: .admin)
        return try decode(WorkflowEnvelope.self, from: data).workflow
    }

    func deleteWorkflow(id: String) async throws {
        _ = try await send("/api/workflows/\(id)", method: "DELETE", access: .admin)
    }

    // MARK: - 使用端会话

    func consumerSession(workflowId: String, sessionId: String?) async throws -> ConsumerSessionResponse {
        var query = [URLQueryItem(name: "workflowId", value: workflowId)]
        if let sessionId, !sessionId.isEmpty {
            query.append(URLQueryItem(name: "sessionId", value: sessionId))
        }
        let data = try await send("/api/consumer/session", query: query, access: .execution)
        return try decode(ConsumerSessionResponse.self, from: data)
    }

    func createConsumerSession(workflowId: String) async throws -> ConsumerSessionResponse {
        let data = try await send(
            "/api/consumer/session",
            method: "PUT",
            body: ["workflowId": workflowId],
            access: .execution
        )
        return try decode(ConsumerSessionResponse.self, from: data)
    }

    /// 一轮对话：回复、意图、优先级与这一次运行的证据一起回来。
    func chat(
        workflowId: String,
        message: String,
        sessionId: String?,
        consumerSessionId: String?,
        llm: LlmConfig
    ) async throws -> AgentChatResponse {
        var body: [String: Any] = [
            "workflowId": workflowId,
            "message": message,
            "provider": llm.provider,
            "reasoningEffort": llm.reasoningEffort,
        ]
        if let sessionId, !sessionId.isEmpty { body["sessionId"] = sessionId }
        if let consumerSessionId, !consumerSessionId.isEmpty { body["consumerSessionId"] = consumerSessionId }
        if !llm.apiKey.isEmpty { body["apiKey"] = llm.apiKey }
        if !llm.baseUrl.isEmpty { body["baseUrl"] = llm.baseUrl }
        if !llm.model.isEmpty { body["model"] = llm.model }
        let data = try await send("/api/agent/chat", method: "POST", body: body, access: .execution)
        return try decode(AgentChatResponse.self, from: data)
    }

    /// 健康检查：网关页用它显示连接状态。
    func ping() async throws -> StateResponse {
        try await state(runPage: 0)
    }
}
