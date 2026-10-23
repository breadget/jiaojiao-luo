import SwiftUI

/// 创建端：夜间机器人调度台。
/// 节点库、画布与 Inspector 在手机宽度下改为“清单 + 检查器”，保留可执行图的语义。
struct StudioView: View {
    var model: AppModel

    @State private var editingStep: WorkflowStep?
    @State private var isAddingStep = false
    @State private var confirmDelete = false

    var body: some View {
        ZStack {
            U.studioBackground.ignoresSafeArea()
            VStack(spacing: 0) {
                commandBar
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if model.editingWorkflow == nil {
                            emptyState
                        } else {
                            basicsPanel
                            stepsPanel
                            publishPanel
                            runsPanel
                            dangerPanel
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 18)
                    .frame(maxWidth: 720)
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .preferredColorScheme(.dark)
        .sheet(item: $editingStep) { step in
            StepEditorSheet(step: step) { updated in
                if let index = model.draftSteps.firstIndex(where: { $0.id == updated.id }) {
                    model.draftSteps[index] = updated
                }
            }
        }
        .sheet(isPresented: $isAddingStep) {
            StepEditorSheet(step: WorkflowStep(title: "", detail: "", kind: .transform)) { created in
                model.draftSteps.append(created)
            }
        }
        .confirmationDialog(
            "删除这个工作流？",
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button("删除", role: .destructive) {
                Task { await model.deleteEditingWorkflow() }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("至少保留一个工作流；删除后已发布版本一并失效。")
        }
    }

    // MARK: - 命令栏

    private var commandBar: some View {
        HStack(spacing: 8) {
            Button {
                model.portal = .gateway
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(U.studioMuted)
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)

            HStack(spacing: 9) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(U.studioAction)
                        .frame(width: 30, height: 30)
                    WorkflowGlyph(color: U.studioBackground, lineWidth: 2.3)
                        .frame(width: 16, height: 16)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text("创建工作流端")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(U.studioText)
                        .lineLimit(1)
                        .fixedSize()
                    Text(versionSummary)
                        .font(.urtorisLabel(9, weight: .semibold))
                        .foregroundStyle(U.studioMuted)
                        .lineLimit(1)
                        .fixedSize()
                }
            }

            Spacer(minLength: 4)

            Menu {
                ForEach(model.workflows) { workflow in
                    Button {
                        model.selectForEditing(workflow)
                    } label: {
                        Label(
                            workflow.name,
                            systemImage: workflow.id == model.editingWorkflowId ? "checkmark" : "square.stack"
                        )
                    }
                }
                Divider()
                Button {
                    Task { await model.addWorkflow() }
                } label: {
                    Label("新建工作流", systemImage: "plus")
                }
            } label: {
                Image(systemName: "list.bullet")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(U.studioMuted)
                    .frame(width: 34, height: 34)
            }

            Button {
                Task { await model.saveEditingWorkflow(publish: false) }
            } label: {
                Text("保存草稿")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(U.studioText)
                    .padding(.horizontal, 12)
                    .frame(height: 34)
                    .overlay(
                        RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                            .stroke(U.studioLine, lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)
            .disabled(model.editingWorkflow == nil || model.creatorBusy)

            Button {
                Task { await model.saveEditingWorkflow(publish: true) }
            } label: {
                Text("发布")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(U.studioBackground)
                    .padding(.horizontal, 14)
                    .frame(height: 34)
                    .background(U.studioAction, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(model.editingWorkflow == nil || model.creatorBusy)
        }
        .padding(.horizontal, 12)
        .frame(height: 64)
        .background(U.studioPanel)
        .overlay(alignment: .bottom) { Hairline(color: U.studioLine) }
    }

    private var versionSummary: String {
        guard let workflow = model.editingWorkflow else { return "还没有工作流" }
        let state = workflow.isPublished ? "已发布 v\(workflow.version)" : "未发布"
        let dirty = model.draftSteps.count != workflow.draftSteps.count
        return dirty ? "\(state) · 草稿有改动" : state
    }

    // MARK: - 面板

    private var basicsPanel: some View {
        StudioPanel(title: "基本信息") {
            VStack(spacing: 12) {
                StudioField(label: "工作流名称", text: Binding(
                    get: { model.draftName },
                    set: { model.draftName = $0 }
                ))
                VStack(alignment: .leading, spacing: 6) {
                    Text("说明")
                        .font(.urtorisLabel(10, weight: .semibold))
                        .foregroundStyle(U.studioMuted)
                    TextField("这份工作流替谁解决什么问题", text: Binding(
                        get: { model.draftDescription },
                        set: { model.draftDescription = $0 }
                    ), axis: .vertical)
                        .textFieldStyle(.plain)
                        .font(.system(size: 14))
                        .foregroundStyle(U.studioText)
                        .lineLimit(2...4)
                        .padding(10)
                        .background(U.studioBackground, in: RoundedRectangle(
                            cornerRadius: Radius.field, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: Radius.field, style: .continuous)
                                .stroke(U.studioLine, lineWidth: 1)
                        )
                }
            }
        }
    }

    private var stepsPanel: some View {
        StudioPanel(title: "步骤 · \(model.draftSteps.count)/12") {
            VStack(spacing: 10) {
                ForEach(Array(model.draftSteps.enumerated()), id: \.element.id) { index, step in
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(index + 1)")
                            .font(.urtorisLabel(11, weight: .bold))
                            .foregroundStyle(U.studioBackground)
                            .frame(width: 24, height: 24)
                            .background(
                                stepKindColor(step.kind),
                                in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                            )
                        VStack(alignment: .leading, spacing: 3) {
                            Text(step.title.isEmpty ? "未命名步骤" : step.title)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(U.studioText)
                            Text(step.detail)
                                .font(.system(size: 12))
                                .foregroundStyle(U.studioMuted)
                                .lineLimit(2)
                        }
                        Spacer(minLength: 4)
                        Menu {
                            Button {
                                editingStep = step
                            } label: {
                                Label("编辑", systemImage: "pencil")
                            }
                            Button {
                                move(index, by: -1)
                            } label: {
                                Label("上移", systemImage: "arrow.up")
                            }
                            .disabled(index == 0)
                            Button {
                                move(index, by: 1)
                            } label: {
                                Label("下移", systemImage: "arrow.down")
                            }
                            .disabled(index == model.draftSteps.count - 1)
                            Divider()
                            Button(role: .destructive) {
                                model.draftSteps.removeAll { $0.id == step.id }
                            } label: {
                                Label("删除", systemImage: "trash")
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(U.studioMuted)
                                .frame(width: 32, height: 32)
                        }
                    }
                    .padding(10)
                    .background(U.studioBackground, in: RoundedRectangle(
                        cornerRadius: Radius.card, style: .continuous))
                }

                Button {
                    isAddingStep = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "plus")
                        Text("添加步骤")
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(U.studioAction)
                    .frame(maxWidth: .infinity)
                    .frame(height: 38)
                    .overlay(
                        RoundedRectangle(cornerRadius: Radius.field, style: .continuous)
                            .stroke(U.studioLine, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    )
                }
                .buttonStyle(.plain)
                .disabled(model.draftSteps.count >= 12)
            }
        }
    }

    private var publishPanel: some View {
        StudioPanel(title: "发布状态") {
            VStack(alignment: .leading, spacing: 10) {
                studioRow("当前版本", model.editingWorkflow.map { "v\($0.version)" } ?? "—")
                studioRow("已发布步骤", "\(model.editingWorkflow?.publishedSteps?.count ?? 0) 个")
                studioRow("执行引擎", model.editingWorkflow?.n8nWebhookUrl == nil ? "内置模拟执行器" : "n8n webhook")
                if model.editingWorkflow?.hasUnpublishedChanges == true {
                    HStack(spacing: 8) {
                        Circle().fill(U.studioAction).frame(width: 7, height: 7)
                        Text("草稿有未发布的改动，使用端仍装载上一个已发布版本。")
                            .font(.system(size: 12))
                            .foregroundStyle(U.studioAction)
                    }
                }
                if let notice = model.creatorNotice {
                    Text(notice)
                        .font(.system(size: 12))
                        .foregroundStyle(U.green)
                }
                if let error = model.creatorError {
                    Text(error)
                        .font(.system(size: 12))
                        .foregroundStyle(U.studioAction)
                }
            }
        }
    }

    private var runsPanel: some View {
        StudioPanel(title: "最近运行") {
            VStack(spacing: 8) {
                if model.runs.isEmpty {
                    Text("还没有运行记录。")
                        .font(.system(size: 13))
                        .foregroundStyle(U.studioMuted)
                }
                ForEach(model.runs.prefix(6)) { run in
                    HStack(spacing: 10) {
                        Circle()
                            .fill(run.status == .failed ? U.studioAction : U.green)
                            .frame(width: 7, height: 7)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(run.workflowName)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(U.studioText)
                            Text("\(run.status.label) · v\(run.workflowVersion) · \(run.steps.count) 步")
                                .font(.urtorisLabel(10, weight: .semibold))
                                .foregroundStyle(U.studioMuted)
                        }
                        Spacer()
                    }
                    .padding(.vertical, 4)
                }
            }
        }
    }

    private var dangerPanel: some View {
        StudioPanel(title: "管理") {
            VStack(spacing: 10) {
                Button {
                    Task { await model.addWorkflow() }
                } label: {
                    Text("新建工作流")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(U.studioText)
                        .frame(maxWidth: .infinity)
                        .frame(height: 38)
                        .overlay(
                            RoundedRectangle(cornerRadius: Radius.field, style: .continuous)
                                .stroke(U.studioLine, lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)

                Button {
                    confirmDelete = true
                } label: {
                    Text("删除当前工作流")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(U.studioAction)
                        .frame(maxWidth: .infinity)
                        .frame(height: 38)
                        .overlay(
                            RoundedRectangle(cornerRadius: Radius.field, style: .continuous)
                                .stroke(U.studioAction.opacity(0.5), lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            WorkflowGlyph(color: U.studioMuted, lineWidth: 2)
                .frame(width: 40, height: 40)
            Text("还没有工作流")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(U.studioText)
            Text("新建一个工作流，添加步骤后发布给使用端装载。")
                .font(.system(size: 13))
                .foregroundStyle(U.studioMuted)
                .multilineTextAlignment(.center)
            Button {
                Task { await model.addWorkflow() }
            } label: {
                Text("新建工作流")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(U.studioBackground)
                    .padding(.horizontal, 16)
                    .frame(height: 38)
                    .background(U.studioAction, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
    }

    private func studioRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(.urtorisLabel(10, weight: .semibold))
                .foregroundStyle(U.studioMuted)
            Spacer()
            Text(value)
                .font(.system(size: 13))
                .foregroundStyle(U.studioText)
        }
    }

    private func move(_ index: Int, by offset: Int) {
        let target = index + offset
        guard model.draftSteps.indices.contains(index),
              model.draftSteps.indices.contains(target) else { return }
        model.draftSteps.swapAt(index, target)
    }
}

struct StudioPanel<Content: View>: View {
    var title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(U.studioText)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(U.studioPanel, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .stroke(U.studioLine, lineWidth: 1)
        )
    }
}

struct StudioField: View {
    var label: String
    @Binding var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.urtorisLabel(10, weight: .semibold))
                .foregroundStyle(U.studioMuted)
            TextField("", text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 14))
                .foregroundStyle(U.studioText)
                .padding(10)
                .background(U.studioBackground, in: RoundedRectangle(
                    cornerRadius: Radius.field, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: Radius.field, style: .continuous)
                        .stroke(U.studioLine, lineWidth: 1)
                )
        }
    }
}

struct StepEditorSheet: View {
    @State var step: WorkflowStep
    var onSave: (WorkflowStep) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("步骤类型") {
                    Picker("类型", selection: $step.kind) {
                        ForEach(StepKind.allCases) { kind in
                            Text(kind.label).tag(kind)
                        }
                    }
                    .pickerStyle(.segmented)
                }
                Section("标题") {
                    TextField("这一步做什么", text: $step.title)
                }
                Section("细节") {
                    TextField("写清输入、判断依据或输出", text: $step.detail, axis: .vertical)
                        .lineLimit(3...6)
                }
            }
            .navigationTitle(step.title.isEmpty ? "新增步骤" : "编辑步骤")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("保存") {
                        var updated = step
                        if updated.title.trimmingCharacters(in: .whitespaces).isEmpty {
                            updated.title = updated.kind.label
                        }
                        onSave(updated)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
        }
    }
}
