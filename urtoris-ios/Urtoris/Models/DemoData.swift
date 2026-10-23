import Foundation

/// 仅用于 `-demoMode 1`（Xcode 预览与无服务端时的界面验收）。
/// 真实运行时全部数据来自仓库里的 `/api/**`。
enum DemoData {
    static let workflowA = WorkflowRecord(
        id: "wf_customer_triage",
        name: "客户咨询分级",
        description: "把散乱的咨询归到三类，产出可跟进的处理建议。",
        draftSteps: [
            WorkflowStep(id: "s1", title: "读入咨询原文", detail: "接收客服邮箱导出的原始咨询。", kind: .input),
            WorkflowStep(id: "s2", title: "提取关键诉求", detail: "抽出产品、问题、时限三类要素。", kind: .transform),
            WorkflowStep(id: "s3", title: "判断紧急程度", detail: "含退款或投诉字样时升级为高优先级。", kind: .decision),
            WorkflowStep(id: "s4", title: "生成处理建议", detail: "按分类给出回复要点与负责人。", kind: .compose),
            WorkflowStep(id: "s5", title: "输出跟进清单", detail: "输出带优先级的待办列表。", kind: .output),
        ],
        publishedSteps: [
            WorkflowStep(id: "s1", title: "读入咨询原文", detail: "接收客服邮箱导出的原始咨询。", kind: .input),
            WorkflowStep(id: "s2", title: "提取关键诉求", detail: "抽出产品、问题、时限三类要素。", kind: .transform),
            WorkflowStep(id: "s3", title: "判断紧急程度", detail: "含退款或投诉字样时升级为高优先级。", kind: .decision),
            WorkflowStep(id: "s4", title: "生成处理建议", detail: "按分类给出回复要点与负责人。", kind: .compose),
            WorkflowStep(id: "s5", title: "输出跟进清单", detail: "输出带优先级的待办列表。", kind: .output),
        ],
        version: 3,
        hasUnpublishedChanges: false,
        createdAt: 1_757_000_000_000,
        updatedAt: 1_758_300_000_000,
        publishedAt: 1_758_300_000_000,
        n8nWebhookUrl: nil
    )

    static let workflowB = WorkflowRecord(
        id: "wf_patrol_report",
        name: "巡检报告整理",
        description: "把现场照片与口述记录整理成一份带结论的巡检报告。",
        draftSteps: [
            WorkflowStep(id: "p1", title: "收集现场记录", detail: "读取照片清单与口述转写。", kind: .input),
            WorkflowStep(id: "p2", title: "归并同类问题", detail: "按设备与位置归并重复问题。", kind: .transform),
            WorkflowStep(id: "p3", title: "生成报告正文", detail: "按结论先行的结构写成三段。", kind: .compose),
            WorkflowStep(id: "p4", title: "输出待复查项", detail: "列出需要二次确认的条目。", kind: .output),
        ],
        publishedSteps: [
            WorkflowStep(id: "p1", title: "收集现场记录", detail: "读取照片清单与口述转写。", kind: .input),
            WorkflowStep(id: "p2", title: "归并同类问题", detail: "按设备与位置归并重复问题。", kind: .transform),
        ],
        version: 2,
        hasUnpublishedChanges: true,
        createdAt: 1_757_200_000_000,
        updatedAt: 1_758_500_000_000,
        publishedAt: 1_758_360_000_000,
        n8nWebhookUrl: nil
    )

    static let workflowC = WorkflowRecord(
        id: "wf_daily_rollup",
        name: "每日数据汇总",
        description: "把三个来源的日报合并成一份可发给主管的汇总。",
        draftSteps: [
            WorkflowStep(id: "d1", title: "拉取三份日报", detail: "从邮箱与共享盘读取当日日报。", kind: .input),
            WorkflowStep(id: "d2", title: "对齐指标口径", detail: "把不同命名换算到同一口径。", kind: .transform),
            WorkflowStep(id: "d3", title: "写出汇总", detail: "给出总量、环比与异常项。", kind: .compose),
        ],
        publishedSteps: nil,
        version: 1,
        hasUnpublishedChanges: true,
        createdAt: 1_758_000_000_000,
        updatedAt: 1_758_600_000_000,
        publishedAt: nil,
        n8nWebhookUrl: nil
    )

    static var workflows: [WorkflowRecord] { [workflowA, workflowB, workflowC] }

    static func run(for workflow: WorkflowRecord, index: Int = 0) -> WorkflowRun {
        let steps = workflow.publishedSteps ?? workflow.draftSteps
        let now = Date().timeIntervalSince1970 * 1000
        return WorkflowRun(
            id: "run_\(workflow.id)_\(index)",
            workflowId: workflow.id,
            workflowName: workflow.name,
            workflowVersion: workflow.version,
            status: index % 5 == 4 ? .failed : .completed,
            steps: steps,
            logs: steps.enumerated().map { offset, step in
                RunLog(
                    at: now - Double((steps.count - offset) * 900),
                    level: offset == steps.count - 1 ? "success" : "info",
                    message: "步骤「\(step.title)」\(offset == steps.count - 1 ? "完成" : "通过")",
                    stepId: step.id
                )
            },
            output: RunOutput(
                summary: "按 \(workflow.name) 处理完成",
                processed: Double(steps.count),
                result: "共处理 \(steps.count) 个步骤，产出 1 份结果。"
            ),
            startedAt: now - 60_000,
            finishedAt: now - 52_000,
            engine: "simulated"
        )
    }

    static var runs: [WorkflowRun] {
        [
            run(for: workflowA, index: 0),
            run(for: workflowB, index: 1),
            run(for: workflowA, index: 2),
            run(for: workflowB, index: 3),
            run(for: workflowA, index: 4),
        ]
    }

    static var conversations: [ConversationSummary] {
        let now = Date().timeIntervalSince1970 * 1000
        return [
            ConversationSummary(id: "cs_1", workflowId: workflowA.id, engineSessionId: "s_1",
                                title: "整理本周客户咨询", createdAt: now - 7_200_000, updatedAt: now - 600_000),
            ConversationSummary(id: "cs_2", workflowId: workflowB.id, engineSessionId: "s_2",
                                title: "巡检照片归档", createdAt: now - 86_400_000, updatedAt: now - 3_600_000),
            ConversationSummary(id: "cs_3", workflowId: workflowA.id, engineSessionId: "s_3",
                                title: "退款类咨询优先处理", createdAt: now - 172_800_000, updatedAt: now - 90_000_000),
        ]
    }

    static func messages(for conversation: ConversationSummary) -> [ChatTurn] {
        let now = Date().timeIntervalSince1970 * 1000
        switch conversation.id {
        case "cs_1":
            return [
                ChatTurn(role: .user, text: "帮我按客户咨询分级流程处理这周的咨询，重点看有没有需要当天回复的。", at: now - 7_100_000),
                ChatTurn(role: .agent, text: "已按「客户咨询分级」装载流程跑完本周 128 条咨询：高优先级 11 条（含 4 条退款、2 条投诉），需要当天回复；中优先级 46 条；其余为常规咨询。高优先级的原文与建议回复要点都整理在跟进清单里。", at: now - 7_000_000, mode: "simulated", intent: "执行工作流", runId: "run_wf_customer_triage_0"),
                ChatTurn(role: .user, text: "把 4 条退款咨询单独列出来。", at: now - 700_000),
                ChatTurn(role: .agent, text: "4 条退款咨询已单独列出，按提交时间排序，并标注了各自的订单号与承诺时限。", at: now - 600_000, mode: "simulated", intent: "执行工作流", runId: "run_wf_customer_triage_2"),
            ]
        case "cs_3":
            return [
                ChatTurn(role: .user, text: "退款类咨询按什么标准判定为高优先级？", at: now - 90_000_000),
                ChatTurn(role: .agent, text: "按已发布版本里的判断步骤：出现「退款」「投诉」「监管」任一关键词即升级为高优先级，并附带承诺时限要求。", at: now - 89_000_000, mode: "simulated", intent: "解释流程"),
            ]
        default:
            return [
                ChatTurn(role: .user, text: "把昨天现场的照片和口述记录整理成巡检报告，结论放最前面。", at: now - 3_500_000),
                ChatTurn(role: .agent, text: "已按「巡检报告整理」的已发布版本（v2，前两步）生成报告草稿：结论段指出 2 号泵房配电箱温度异常，建议当日复查；正文按设备归并了 6 条同类问题；待复查项 3 条。", at: now - 3_400_000, mode: "simulated", intent: "执行工作流", runId: "run_wf_patrol_report_1"),
            ]
        }
    }

    /// 演示模式下的一轮回复（真实模式走 `/api/agent/chat`）。
    static func reply(to message: String, workflow: WorkflowRecord?) -> AgentChatResponse {
        let name = workflow?.name ?? "当前工作流"
        let steps = workflow?.publishedSteps ?? workflow?.draftSteps ?? []
        return AgentChatResponse(
            reply: """
            已按「\(name)」装载的 \(steps.count) 个步骤处理你的要求：\(message.prefix(40))。
            执行过程中没有出现需要中断的情况，完整步骤与日志可以在执行详情里展开查看。
            """,
            intent: "执行工作流",
            priority: "中",
            run: workflow.map { run(for: $0, index: 0) },
            mode: "simulated",
            sessionId: "s_demo"
        )
    }
}
