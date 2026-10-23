import SwiftUI

/// 使用端设置：模型、接口与本机服务地址。
/// API Key 只写入本机钥匙串，不下发到服务端存储。
struct ConsumerSettingsSheet: View {
    var model: AppModel
    @Binding var isPresented: Bool

    @State private var draft = LlmConfig()
    @State private var serviceURL = ""
    @State private var servicePreset = 0
    @State private var draftAdminToken = ""
    @State private var draftApiToken = ""
    @State private var saved = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("模型服务", selection: $draft.provider) {
                        ForEach(LlmConfig.providers, id: \.id) { provider in
                            Text(provider.label).tag(provider.id)
                        }
                    }
                    .onChange(of: draft.provider) {
                        guard let preset = LlmConfig.providers.first(where: { $0.id == draft.provider }) else { return }
                        if draft.model.isEmpty { draft.model = preset.defaultModel }
                        if draft.baseUrl.isEmpty { draft.baseUrl = preset.defaultBaseUrl }
                    }
                    TextField("API Key", text: $draft.apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("接口地址", text: $draft.baseUrl)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("模型名称", text: $draft.model)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Picker("推理强度", selection: $draft.reasoningEffort) {
                        Text("低").tag("low")
                        Text("中").tag("medium")
                        Text("高").tag("high")
                    }
                } header: {
                    Text("使用端模型")
                } footer: {
                    Text("留空则使用服务端内置的规则模拟器；填入后按你的模型直连，Key 只保存在本机钥匙串。")
                }

                Section {
                    Picker("连接方式", selection: $servicePreset) {
                        Text("本机开发服务器").tag(0)
                        Text("公网 urtoris.cn").tag(1)
                        Text("自定义地址").tag(2)
                    }
                    .onChange(of: servicePreset) {
                        switch servicePreset {
                        case 0: serviceURL = "http://localhost:3000"
                        case 1: serviceURL = "https://urtoris.cn"
                        default: break
                        }
                    }
                    if servicePreset == 2 {
                        TextField("https://你的域名", text: $serviceURL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                    } else {
                        Text(serviceURL)
                            .font(.urtorisLabel(11, weight: .regular))
                            .foregroundStyle(.secondary)
                    }
                    Button("保存并重新连接") {
                        model.llmConfig = draft
                        model.saveLlmConfig()
                        model.serviceURLText = serviceURL
                        model.applyServiceURL()
                        saved = true
                    }
                } header: {
                    Text("工作流服务")
                } footer: {
                    Text("模拟器用本机地址即可；真机连同 Wi-Fi 的 Mac 选自定义并填局域网 IP；想在任意网络下使用就选公网。公网只读接口免令牌，使用端对话靠同源声明放行，创建端写操作需要下面的管理员令牌。")
                }

                Section {
                    SecureField("URTORIS_ADMIN_TOKEN", text: $draftAdminToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("URTORIS_API_TOKEN", text: $draftApiToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("保存令牌") {
                        model.adminToken = draftAdminToken
                        model.apiToken = draftApiToken
                        model.applyTokens()
                        saved = true
                    }
                } header: {
                    Text("访问令牌（公网写操作需要）")
                } footer: {
                    Text("服务端把本机 / 内网请求视为可信会话；域名或公网 IP 访问时，创建端写操作需要管理员令牌，使用端对话需要 API 令牌。令牌只写进本机钥匙串。")
                }

                Section("关于") {
                    LabeledContent("运行模式", value: model.isDemo ? "演示数据" : "连接服务")
                    LabeledContent("已发布版本", value: "\(model.publishedWorkflows.count)")
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(saved ? "已保存" : "完成") { isPresented = false }
                }
            }
            .onAppear {
                draft = model.llmConfig
                serviceURL = model.serviceURLText
                if serviceURL.contains("localhost") || serviceURL.contains("127.0.0.1") {
                    servicePreset = 0
                } else if serviceURL.contains("urtoris.cn") {
                    servicePreset = 1
                } else {
                    servicePreset = 2
                }
                draftAdminToken = model.adminToken
                draftApiToken = model.apiToken
            }
        }
    }
}
