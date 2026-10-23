import { graphOf, makeEdge, makeNode } from './graph';
import type { WorkflowGraphV1 } from '@/lib/workflow-graph/types';

export function localDatabaseGraph(
  id = 'wf_local_database',
  filePath = '/Users/me/data/orders.sqlite',
): WorkflowGraphV1 {
  return graphOf(
    [
      makeNode('trigger', 'local_trigger', { name: '接收请求' }),
      makeNode('aiAgent', 'local_agent', {
        name: '数据库助手',
        config: {
          instructions: '根据数据库中的订单回答问题。',
          constraints: '只允许查询订单。',
          maxIterations: 6,
        },
      }),
      makeNode('llmModel', 'local_model', {
        config: { provider: 'openai', model: 'gpt-4o-mini' },
      }),
      makeNode('database', 'local_database', {
        name: '订单数据库',
        config: {
          provider: 'sqlite',
          location: 'local',
          filePath,
          operation: 'select',
          maxRows: 100,
        },
      }),
      makeNode('output', 'local_output', { name: '返回结果' }),
    ],
    [
      makeEdge('local_trigger', 'main.out', 'local_agent', 'main.in'),
      makeEdge('local_agent', 'main.out', 'local_output', 'main.in'),
      makeEdge(
        'local_agent',
        'resource.model',
        'local_model',
        'model.provider',
        'model',
      ),
      makeEdge(
        'local_agent',
        'resource.tools',
        'local_database',
        'tool.provider',
        'tool',
      ),
    ],
    { id, name: '本机订单助手' },
  );
}
