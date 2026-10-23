import type { WorkflowRecord, WorkflowStep } from '@/lib/workflow-types';

export type AgentAnalysis = {
  intent: string;
  priority: '高' | '中' | '低';
  keywords: string[];
  action: string;
};

type IntentRule = {
  pattern: RegExp;
  label: string;
  priority: AgentAnalysis['priority'];
  action: string;
};

const intentRules: IntentRule[] = [
  {
    pattern: /(退款|退货|退钱|refund)/i,
    label: '退款 / 退货',
    priority: '高',
    action: '转交退款专员，24 小时内联系确认',
  },
  {
    pattern: /(闪退|崩溃|打不开|白屏|卡死|报错|无法启动|无法登录|bug)/i,
    label: '技术故障',
    priority: '高',
    action: '转技术队列，优先收集设备与日志信息',
  },
  {
    pattern: /(发货|物流|快递|包裹|配送|没收到|还没到)/i,
    label: '订单与物流',
    priority: '中',
    action: '查询物流节点，反馈最新配送状态',
  },
  {
    pattern: /(发票|报销|开票)/i,
    label: '发票与报销',
    priority: '中',
    action: '生成电子发票并发送至登记邮箱',
  },
  {
    pattern: /(咨询|价格|费用|套餐|续费|多少钱|介绍)/i,
    label: '产品咨询',
    priority: '低',
    action: '回复产品资料与报价说明',
  },
];

const keywordPool = [
  '退款',
  '退货',
  '订单',
  '发货',
  '物流',
  '快递',
  '包裹',
  '发票',
  '报销',
  '闪退',
  '崩溃',
  '报错',
  '登录',
  '套餐',
  '续费',
  '价格',
  '咨询',
];

export function analyzeMessage(message: string): AgentAnalysis {
  const matched = intentRules.find((rule) => rule.pattern.test(message));
  const keywords = keywordPool
    .filter((word) => message.includes(word))
    .slice(0, 4);

  if (matched) {
    return {
      intent: matched.label,
      priority: matched.priority,
      keywords,
      action: matched.action,
    };
  }

  return {
    intent: '一般问题',
    priority: '中',
    keywords,
    action: '整理问题要点，给出初步建议',
  };
}

type SeenKinds = {
  input: boolean;
  transform: boolean;
  decision: boolean;
  compose: boolean;
  output: boolean;
};

function stepClause(
  step: WorkflowStep,
  message: string,
  analysis: AgentAnalysis,
  seen: SeenKinds,
): string {
  switch (step.kind) {
    case 'input':
      seen.input = true;
      return `已接收消息（${message.length} 字）并解析主题`;
    case 'transform':
      if (!seen.transform) {
        seen.transform = true;
        return analysis.keywords.length
          ? `提取到关键词：${analysis.keywords.join('、')}`
          : '完成消息清洗与结构化整理';
      }
      return `已按「${step.detail}」完成数据处理`;
    case 'decision':
      if (!seen.decision) {
        seen.decision = true;
        return `判定意图为「${analysis.intent}」，优先级：${analysis.priority}`;
      }
      return `已按「${step.detail}」完成条件判断`;
    case 'compose':
      if (!seen.compose) {
        seen.compose = true;
        return `生成建议动作：${analysis.action}`;
      }
      return `已按「${step.detail}」生成内容`;
    case 'output':
      seen.output = true;
      return '结果已回传到使用端，可继续追问';
  }
}

export function buildAgentReply(
  workflow: WorkflowRecord,
  message: string,
  analysis: AgentAnalysis,
): string {
  const seen: SeenKinds = {
    input: false,
    transform: false,
    decision: false,
    compose: false,
    output: false,
  };
  const lines =
    workflow.publishedSteps?.map((step, index) => {
      const clause = stepClause(step, message, analysis, seen);
      return `${String(index + 1).padStart(2, '0')} · ${step.title}｜${clause}`;
    }) ?? [];

  return [
    `已按「${workflow.name}」v${workflow.version} 处理完你的请求：`,
    '',
    ...lines,
    '',
    `结论：${analysis.intent}，${analysis.priority}优先级 → ${analysis.action}。`,
  ].join('\n');
}
