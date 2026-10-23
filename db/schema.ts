import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const workflows = sqliteTable(
  'workflows',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    draftStepsJson: text('draft_steps_json').notNull(),
    publishedStepsJson: text('published_steps_json'),
    version: integer('version').notNull().default(0),
    hasUnpublishedChanges: integer('has_unpublished_changes', {
      mode: 'boolean',
    })
      .notNull()
      .default(true),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    publishedAt: integer('published_at'),
    /** 从工作流列表删除时只隐藏，不级联清空历史运行、会话或发布快照。 */
    deletedAt: integer('deleted_at'),
    n8nWebhookUrl: text('n8n_webhook_url'),
    /** 当前生效的 Graph 发布版本；回滚就是移动这个指针。 */
    activeGraphVersionId: text('active_graph_version_id'),
  },
  (table) => [index('idx_workflows_updated_at').on(table.updatedAt)],
);

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id),
    workflowName: text('workflow_name').notNull(),
    workflowVersion: integer('workflow_version').notNull(),
    status: text('status', {
      enum: ['queued', 'running', 'completed', 'failed'],
    }).notNull(),
    stepsJson: text('steps_json').notNull(),
    logsJson: text('logs_json').notNull(),
    outputJson: text('output_json').notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    // ↓ 协议 v1 新增：全链路可观测字段
    requestId: text('request_id'),
    sessionId: text('session_id'),
    engine: text('engine'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),
    attempts: integer('attempts'),
    executionId: text('execution_id'),
    mode: text('mode'),
    degraded: integer('degraded', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    index('idx_runs_workflow_started_at').on(table.workflowId, table.startedAt),
    index('idx_runs_request_id').on(table.requestId),
    index('idx_runs_session_id').on(table.sessionId),
  ],
);

/**
 * 使用端的匿名浏览器会话。浏览器只保存高熵 HttpOnly token，
 * D1 只保存其 SHA-256；每个已发布工作流有独立对话分区。
 */
export const consumerSessions = sqliteTable(
  'consumer_sessions',
  {
    id: text('id').primaryKey(),
    browserKeyHash: text('browser_key_hash').notNull(),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    engineSessionId: text('engine_session_id').notNull(),
    title: text('title').notNull().default('新对话'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_consumer_sessions_browser_workflow_updated').on(
      table.browserKeyHash,
      table.workflowId,
      table.updatedAt,
    ),
    index('idx_consumer_sessions_updated_at').on(table.updatedAt),
  ],
);

export const consumerMessages = sqliteTable(
  'consumer_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => consumerSessions.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'agent'] }).notNull(),
    status: text('status', {
      enum: ['working', 'completed', 'failed'],
    }).notNull(),
    text: text('text').notNull(),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_consumer_messages_session_created').on(
      table.sessionId,
      table.createdAt,
    ),
  ],
);

export const consumerPythonRuns = sqliteTable(
  'consumer_python_runs',
  {
    runId: text('run_id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => consumerSessions.id, { onDelete: 'cascade' }),
    agentMessageId: text('agent_message_id').references(
      () => consumerMessages.id,
      { onDelete: 'set null' },
    ),
    taskId: text('task_id').notNull(),
    attempt: integer('attempt').notNull(),
    profile: text('profile', { enum: ['short', 'long'] }).notNull(),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    artifactsJson: text('artifacts_json').notNull().default('[]'),
    metricsJson: text('metrics_json').notNull().default('{}'),
    limitsJson: text('limits_json').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_consumer_python_runs_session_created').on(
      table.sessionId,
      table.createdAt,
    ),
    index('idx_consumer_python_runs_task').on(table.taskId),
    index('idx_consumer_python_runs_status').on(table.status),
  ],
);

/**
 * 确定性执行映射：n8n 在危险节点前写入，站点按 executionId 精确反查。
 * 一个 requestId 在重试时可对应多个 executionId，所以只约束 executionId 唯一。
 */
export const n8nExecutionMap = sqliteTable(
  'n8n_execution_map',
  {
    executionId: text('execution_id').primaryKey(),
    requestId: text('request_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    workflowName: text('workflow_name'),
    sessionId: text('session_id'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_n8n_execution_map_request_id').on(table.requestId),
    index('idx_n8n_execution_map_workflow_id').on(table.workflowId),
  ],
);

/**
 * n8n 执行过程中上报的结构化事件（common-log 子工作流写入）。
 * 与 runs 的区别：runs 是"一次业务请求"，n8n_events 是"这一次请求里每一步发生了什么"。
 */
export const n8nEvents = sqliteTable(
  'n8n_events',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id'),
    sessionId: text('session_id'),
    workflow: text('workflow'),
    executionId: text('execution_id'),
    level: text('level', {
      enum: ['debug', 'info', 'warn', 'error'],
    })
      .notNull()
      .default('info'),
    eventType: text('event_type').notNull().default('log'),
    node: text('node'),
    message: text('message').notNull().default(''),
    payloadJson: text('payload_json'),
    durationMs: integer('duration_ms'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_n8n_events_request_id').on(table.requestId),
    index('idx_n8n_events_created_at').on(table.createdAt),
  ],
);

export const workflowGraphDrafts = sqliteTable(
  'workflow_graph_drafts',
  {
    workflowId: text('workflow_id')
      .primaryKey()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    schemaVersion: integer('schema_version').notNull(),
    revision: integer('revision').notNull().default(0),
    graphJson: text('graph_json').notNull(),
    graphHash: text('graph_hash').notNull(),
    updatedAt: integer('updated_at').notNull(),
    updatedBy: text('updated_by'),
  },
  (table) => [
    index('idx_workflow_graph_drafts_updated_at').on(table.updatedAt),
  ],
);

export const workflowVersions = sqliteTable(
  'workflow_versions',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    /** 发布时草稿的 revision，用于审计"这份快照来自哪一次保存"。 */
    graphRevision: integer('graph_revision').notNull().default(0),
    graphJson: text('graph_json').notNull(),
    graphHash: text('graph_hash').notNull(),
    adapter: text('adapter').notNull(),
    adapterVersion: text('adapter_version').notNull(),
    compiledJson: text('compiled_json'),
    compiledHash: text('compiled_hash'),
    externalWorkflowId: text('external_workflow_id'),
    webhookPath: text('webhook_path'),
    nodeCount: integer('node_count').notNull().default(0),
    connectionCount: integer('connection_count').notNull().default(0),
    publishedAt: integer('published_at').notNull(),
    publishedBy: text('published_by'),
  },
  (table) => [
    uniqueIndex('idx_workflow_versions_workflow_version').on(
      table.workflowId,
      table.version,
    ),
  ],
);

export const workflowNodeBindings = sqliteTable(
  'workflow_node_bindings',
  {
    workflowVersionId: text('workflow_version_id')
      .notNull()
      .references(() => workflowVersions.id, { onDelete: 'cascade' }),
    internalNodeId: text('internal_node_id').notNull(),
    externalNodeId: text('external_node_id').notNull(),
    externalNodeName: text('external_node_name'),
    role: text('role').notNull().default('primary'),
  },
  (table) => [
    primaryKey({
      columns: [
        table.workflowVersionId,
        table.internalNodeId,
        table.externalNodeId,
      ],
    }),
  ],
);
