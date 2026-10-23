import { createGraphNode } from '@/lib/workflow-graph/registry';
import type {
  WorkflowGraphEdge,
  WorkflowGraphV1,
} from '@/lib/workflow-graph/types';

/** Both starters execute their saved graph. Original-source export requires no model key. */
export function createCourseProgramGraph(
  workflowId: string,
  options: { withModel?: boolean } = {},
): WorkflowGraphV1 {
  const withModel = options.withModel !== false;
  const trigger = createGraphNode(
    'trigger',
    { x: 80, y: 160 },
    {
      id: 'course_input',
      name: '填写学习任务',
      description: '指定主题、难度和数量。',
      config: {
        inputFields: [
          {
            name: 'topic',
            label: '课程主题',
            type: 'text',
            required: true,
            min: 1,
            max: 1000,
          },
          {
            name: 'difficulty',
            label: '学习难度',
            type: 'text',
            required: true,
            default: '基础',
            max: 100,
          },
          {
            name: 'count',
            label: withModel ? '练习数量' : '原文条数',
            type: 'number',
            required: true,
            default: 5,
            min: 1,
            max: 20,
          },
        ],
      },
    },
  );
  const knowledge = createGraphNode(
    'courseKnowledge',
    { x: 380, y: 160 },
    {
      id: 'course_sources',
      name: '检索课程原文',
      config: {
        query: '{{input.topic}}',
        ...(withModel ? {} : { maxSources: '{{input.count}}' }),
      },
    },
  );
  const agent = createGraphNode(
    'aiAgent',
    { x: 680, y: 160 },
    {
      id: 'course_writer',
      name: '生成学习练习',
      description: '使用共用模型设置，根据原文生成带来源的练习。',
      config: {
        instructions:
          '依据检索到的原文制作学习练习。先给出知识要点，再给出题目、参考答案和简要解析。每题注明支持它的资料编号，例如 [1]。资料不足时如实说明。',
        constraints:
          '只使用提供的课程资料，不得虚构资料、文件名、页码或课程结论。',
        prompt:
          '主题：{{input.topic}}\n难度：{{input.difficulty}}\n题目数量：{{input.count}}',
        fallbackPolicy: 'error',
      },
    },
  );
  const model = createGraphNode(
    'llmModel',
    { x: 680, y: 400 },
    {
      id: 'course_model',
      name: '共用模型设置',
      description: '实际调用统一使用站点的模型、API Key、端点及推理力度。',
      config: { source: 'globalLlmConfig' },
    },
  );
  const output = createGraphNode(
    'output',
    { x: withModel ? 1020 : 680, y: 160 },
    {
      id: 'course_output',
      name: withModel ? '下载学习资料' : '下载课程原文',
      config: {
        text: '$json.text',
        artifact: {
          name: withModel ? 'course-exercises.md' : 'course-sources.md',
          mimeType: 'text/markdown',
        },
      },
    },
  );
  const mainEdge = (sourceId: string, targetId: string): WorkflowGraphEdge => ({
    id: `edge_${sourceId}_${targetId}`,
    kind: 'main',
    source: { nodeId: sourceId, portId: 'main.out' },
    target: { nodeId: targetId, portId: 'main.in' },
  });
  return {
    schemaVersion: 1,
    id: workflowId,
    name: withModel ? '课程练习生成器' : '课程原文导出',
    description: withModel
      ? '检索课程原文，用共用模型生成有引用的学习练习，并导出 Markdown。'
      : '检索并导出课程原文、文件名与页码，无需模型 API Key。',
    revision: 0,
    nodes: withModel
      ? [trigger, knowledge, agent, model, output]
      : [trigger, knowledge, output],
    edges: withModel
      ? [
          mainEdge(trigger.id, knowledge.id),
          mainEdge(knowledge.id, agent.id),
          mainEdge(agent.id, output.id),
          {
            id: 'edge_course_model',
            kind: 'model',
            source: { nodeId: agent.id, portId: 'resource.model' },
            target: { nodeId: model.id, portId: 'model.provider' },
          },
        ]
      : [mainEdge(trigger.id, knowledge.id), mainEdge(knowledge.id, output.id)],
    entryNodeIds: [trigger.id],
    runtime: {
      engine: 'program',
      adapter: 'program-v1',
      executionMode: 'server',
      binding: 'draft',
    },
    viewport: { x: 0, y: 0, zoom: 1 },
    metadata: { source: 'urtoris', updatedAt: 0 },
  };
}
