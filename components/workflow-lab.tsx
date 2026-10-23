'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomId } from '@/lib/random-id';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  ChevronLeft,
  CircleDashed,
  CirclePlus,
  Copy,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Send,
  Trash2,
  Workflow as WorkflowIcon,
  Wifi,
  Zap,
} from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import {
  DEFAULT_LLM_PROVIDER_ID,
  providerDefaults,
  providerOptions,
} from '@/lib/llm/providers';
import type {
  AgentChatResponse,
  ChatTurn,
  LlmConfig,
  StateResponse,
  StepKind,
  WorkflowRecord,
  WorkflowRun,
  WorkflowStep,
} from '@/lib/workflow-types';

const LLM_STORAGE_KEY = 'urtoris.llm.config.v1';
const ADMIN_TOKEN_STORAGE_KEY = 'urtoris.admin.token.v1';

const defaultLlmConfig: LlmConfig = {
  provider: DEFAULT_LLM_PROVIDER_ID,
  apiKey: '',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-plus',
};

const kindLabels: Record<StepKind, string> = {
  input: '接收输入',
  transform: '处理数据',
  decision: '判断条件',
  compose: '生成内容',
  output: '回传结果',
};

const starterWorkflow: WorkflowRecord = {
  id: 'wf_demo_triage',
  name: '客户请求分流',
  description: '接收一条客户请求，判断优先级，生成处理摘要并回传。',
  draftSteps: [
    {
      id: 'step_intake',
      title: '读取客户请求',
      detail: '接收主题、正文和来源渠道',
      kind: 'input',
    },
    {
      id: 'step_priority',
      title: '判断优先级',
      detail: '根据影响范围和紧急程度分级',
      kind: 'decision',
    },
    {
      id: 'step_summary',
      title: '生成处理摘要',
      detail: '整理问题、优先级和建议动作',
      kind: 'compose',
    },
    {
      id: 'step_return',
      title: '回传到使用端',
      detail: '输出结构化结果与运行记录',
      kind: 'output',
    },
  ],
  publishedSteps: null,
  version: 0,
  hasUnpublishedChanges: true,
  createdAt: 0,
  updatedAt: 0,
  publishedAt: null,
  n8nWebhookUrl: null,
};

const quickPrompts = [
  '我的订单三天了还没发货，想申请退款',
  'App 打开就闪退，根本没法用',
  '想咨询一下会员续费的价格',
  '发票什么时候能开给我',
];

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatClock(timestamp: number | null) {
  if (!timestamp) return '尚未运行';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

type SaveState = 'idle' | 'saving' | 'saved';
type Portal = 'gateway' | 'creator' | 'consumer';

export function WorkflowLab() {
  const [portal, setPortal] = useState<Portal>('gateway');
  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
  const [creatorWorkflowId, setCreatorWorkflowId] = useState<string | null>(
    null,
  );
  const [consumerWorkflowId, setConsumerWorkflowId] = useState<string | null>(
    null,
  );
  /** 当前装载的工作流是否绑定了真实 n8n webhook —— 决定文案与提示该怎么说。 */
  const loadedUsesN8n = useMemo(
    () =>
      Boolean(
        workflows.find((item) => item.id === consumerWorkflowId)?.n8nWebhookUrl,
      ),
    [workflows, consumerWorkflowId],
  );
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [running, setRunning] = useState(false);
  const [activeRun, setActiveRun] = useState<WorkflowRun | null>(null);
  const [visibleLogs, setVisibleLogs] = useState<WorkflowRun['logs']>([]);
  const [currentStepId, setCurrentStepId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiCopied, setApiCopied] = useState(false);
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatProgress, setChatProgress] = useState<{
    turnId: string;
    message: string;
  } | null>(null);
  // 使用端自带的模型配置：只存在这个浏览器里，随请求发给服务端用完即弃。
  const [llmConfig, setLlmConfig] = useState<LlmConfig>(defaultLlmConfig);
  const [llmReady, setLlmReady] = useState(false);
  const [llmPanelOpen, setLlmPanelOpen] = useState(false);
  const [adminToken, setAdminToken] = useState('');
  const [adminTokenReady, setAdminTokenReady] = useState(false);
  /** 服务端把本机/内网访问当管理员会话时为 true（此时不需要令牌）。 */
  const [adminTrusted, setAdminTrusted] = useState(false);
  const runLock = useRef(false);
  const chatLock = useRef(false);
  /** 会话 ID：服务端首次回传后常驻，保证多轮对话落在同一个 n8n Memory 分区里。 */
  const sessionIdRef = useRef<string | null>(null);
  const chatListRef = useRef<HTMLDivElement>(null);
  const gatewayTitleRef = useRef<HTMLHeadingElement>(null);
  const creatorTitleRef = useRef<HTMLHeadingElement>(null);
  const consumerTitleRef = useRef<HTMLHeadingElement>(null);
  const workflowsRef = useRef<WorkflowRecord[]>([]);
  const consumerWorkflowIdRef = useRef<string | null>(null);
  const runActionRef = useRef<
    (workflowId?: string) => Promise<WorkflowRun | null>
  >(async () => null);
  const chatActionRef = useRef<
    (message: string, workflowId?: string) => Promise<WorkflowRun | null>
  >(async () => null);
  const selectConsumerWorkflowRef = useRef<(id: string) => void>(() => {});
  const lastReplyRef = useRef('');

  const editableWorkflows = workflows.length ? workflows : [starterWorkflow];
  const workflow =
    editableWorkflows.find((item) => item.id === creatorWorkflowId) ??
    editableWorkflows[0];
  const consumerWorkflow =
    workflows.find((item) => item.id === consumerWorkflowId) ?? null;
  const publishedWorkflows = workflows.filter((item) =>
    Boolean(item.publishedSteps),
  );
  const publishedSteps = consumerWorkflow?.publishedSteps ?? null;

  const refreshState = useCallback(async () => {
    setLoadState('loading');
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      if (!response.ok) throw new Error('读取本地数据失败');
      const data = (await response.json()) as StateResponse;
      setWorkflows(data.workflows);
      setRuns(data.runs);
      setAdminTrusted(data.adminTrusted === true);
      setCreatorWorkflowId((current) =>
        current && data.workflows.some((item) => item.id === current)
          ? current
          : (data.workflows[0]?.id ?? null),
      );
      setConsumerWorkflowId((current) => {
        if (current && data.workflows.some((item) => item.id === current)) {
          return current;
        }
        return (
          data.workflows.find((item) => item.publishedSteps)?.id ??
          data.workflows[0]?.id ??
          null
        );
      });
      setLoadState('ready');
      setError(null);
    } catch {
      setLoadState('error');
      setError('暂时无法读取本地数据，请刷新后重试。');
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void refreshState());
  }, [refreshState]);

  // 读取本浏览器里保存的模型配置（Key 不入服务端、不进代码库）。
  useEffect(() => {
    queueMicrotask(() => {
      try {
        const raw = window.localStorage.getItem(LLM_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<LlmConfig>;
          const storedProvider =
            typeof parsed.provider === 'string' &&
            providerDefaults(parsed.provider)
              ? parsed.provider
              : defaultLlmConfig.provider;
          setLlmConfig({
            provider: storedProvider,
            apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
            baseUrl:
              typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim()
                ? parsed.baseUrl
                : defaultLlmConfig.baseUrl,
            model:
              typeof parsed.model === 'string' && parsed.model.trim()
                ? parsed.model
                : defaultLlmConfig.model,
          });
        }
      } catch {
        // 读不到就用默认值，不影响页面其他部分。
      }
      setLlmReady(true);
    });
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      try {
        setAdminToken(
          window.sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? '',
        );
      } catch {
        // 隐私模式下无法读取也没关系，管理员仍可在当前页面输入。
      } finally {
        setAdminTokenReady(true);
      }
    });
  }, []);

  useEffect(() => {
    if (!adminTokenReady) return;
    try {
      if (adminToken.trim()) {
        window.sessionStorage.setItem(
          ADMIN_TOKEN_STORAGE_KEY,
          adminToken.trim(),
        );
      } else {
        window.sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
      }
    } catch {
      // 隐私模式下无法保存也没关系。
    }
  }, [adminToken, adminTokenReady]);

  useEffect(() => {
    if (!llmReady) return;
    try {
      window.localStorage.setItem(LLM_STORAGE_KEY, JSON.stringify(llmConfig));
    } catch {
      // 隐私模式下写不进去也没关系。
    }
  }, [llmConfig, llmReady]);

  useEffect(() => {
    window.scrollTo(0, 0);
    const target =
      portal === 'gateway'
        ? gatewayTitleRef.current
        : portal === 'creator'
          ? creatorTitleRef.current
          : consumerTitleRef.current;
    target?.focus();
  }, [portal]);

  const patchWorkflow = (id: string, change: Partial<WorkflowRecord>) => {
    setWorkflows((current) => {
      const list = current.length ? current : [starterWorkflow];
      return list.map((item) =>
        item.id === id
          ? { ...item, ...change, hasUnpublishedChanges: true }
          : item,
      );
    });
    setSaveState('idle');
  };

  const markChanged = (change: Partial<WorkflowRecord>) => {
    patchWorkflow(workflow.id, change);
  };

  const updateStep = (id: string, change: Partial<WorkflowStep>) => {
    patchWorkflow(workflow.id, {
      draftSteps: workflow.draftSteps.map((step) =>
        step.id === id ? { ...step, ...change } : step,
      ),
    });
  };

  const addStep = () => {
    if (workflow.draftSteps.length >= 12) {
      setError('第一版最多支持 12 个步骤；请先删掉一个再添加。');
      return;
    }
    const id = `step_${randomId().slice(0, 8)}`;
    patchWorkflow(workflow.id, {
      draftSteps: [
        ...workflow.draftSteps,
        {
          id,
          title: '新步骤',
          detail: '说明这个步骤要完成什么',
          kind: 'transform',
        },
      ],
    });
    setError(null);
  };

  const removeStep = (id: string) => {
    if (workflow.draftSteps.length === 1) {
      setError('工作流至少需要保留一个步骤。');
      return;
    }
    patchWorkflow(workflow.id, {
      draftSteps: workflow.draftSteps.filter((step) => step.id !== id),
    });
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= workflow.draftSteps.length) return;
    const next = [...workflow.draftSteps];
    [next[index], next[target]] = [next[target], next[index]];
    patchWorkflow(workflow.id, { draftSteps: next });
  };

  const createNewWorkflow = async () => {
    setError(null);
    try {
      const response = await fetch('/api/workflows', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(adminToken.trim()
            ? { Authorization: `Bearer ${adminToken.trim()}` }
            : {}),
        },
        body: JSON.stringify({ action: 'create' }),
      });
      const data = (await response.json()) as {
        workflow?: WorkflowRecord;
        error?: string;
      };
      if (!response.ok || !data.workflow) {
        throw new Error(data.error ?? '新建失败');
      }
      setWorkflows((current) => [data.workflow as WorkflowRecord, ...current]);
      setCreatorWorkflowId(data.workflow.id);
      setSaveState('idle');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '新建失败，请重试。');
    }
  };

  const persistWorkflow = async (action: 'save' | 'publish') => {
    if (
      workflow.name.trim().length < 2 ||
      workflow.draftSteps.some((step) => !step.title.trim())
    ) {
      setError('请填写工作流名称，并确保每个步骤都有名称。');
      return;
    }

    setSaveState('saving');
    setError(null);
    try {
      const response = await fetch('/api/workflows', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(adminToken.trim()
            ? { Authorization: `Bearer ${adminToken.trim()}` }
            : {}),
        },
        body: JSON.stringify({
          id: workflow.id,
          name: workflow.name,
          description: workflow.description,
          steps: workflow.draftSteps,
          action,
          n8nWebhookUrl: workflow.n8nWebhookUrl ?? '',
        }),
      });
      const data = (await response.json()) as {
        workflow?: WorkflowRecord;
        error?: string;
      };
      if (!response.ok || !data.workflow) {
        throw new Error(data.error ?? '保存失败');
      }
      setWorkflows((current) => {
        const list = current.length ? current : [starterWorkflow];
        return list.map((item) =>
          item.id === data.workflow?.id
            ? (data.workflow as WorkflowRecord)
            : item,
        );
      });
      setSaveState('saved');
      if (action === 'publish') {
        setActiveRun(null);
        setVisibleLogs([]);
      }
    } catch (cause) {
      setSaveState('idle');
      setError(cause instanceof Error ? cause.message : '保存失败，请重试。');
    }
  };

  const startRun = useCallback(
    async (requestedWorkflowId?: string): Promise<WorkflowRun | null> => {
      const target =
        workflows.find(
          (item) => item.id === (requestedWorkflowId ?? consumerWorkflowId),
        ) ?? null;
      if (!target?.publishedSteps || running || runLock.current) return null;

      runLock.current = true;
      setRunning(true);
      setCurrentStepId(null);
      setVisibleLogs([]);
      setError(null);

      try {
        const response = await fetch('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workflowId: target.id }),
        });
        const data = (await response.json()) as {
          run?: WorkflowRun;
          error?: string;
        };
        if (!response.ok || !data.run) {
          throw new Error(data.error ?? '运行失败');
        }

        const completedRun = data.run;
        setActiveRun({ ...completedRun, status: 'running' });
        for (let index = 0; index < completedRun.logs.length; index += 1) {
          const log = completedRun.logs[index];
          setVisibleLogs(completedRun.logs.slice(0, index + 1));
          setCurrentStepId(log.stepId ?? null);
          await wait(index === 0 ? 260 : 520);
        }
        setCurrentStepId(null);
        setActiveRun(completedRun);
        setRuns((current) => [completedRun, ...current].slice(0, 8));
        return completedRun;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '运行失败，请重试。');
        setActiveRun(null);
        return null;
      } finally {
        runLock.current = false;
        setRunning(false);
      }
    },
    [running, workflows, consumerWorkflowId],
  );

  const sendChatMessage = useCallback(
    async (
      rawMessage?: string,
      requestedWorkflowId?: string,
    ): Promise<WorkflowRun | null> => {
      const text = (rawMessage ?? chatDraft).trim();
      const target =
        workflows.find(
          (item) => item.id === (requestedWorkflowId ?? consumerWorkflowId),
        ) ?? null;
      if (!text || !target?.publishedSteps || chatLock.current) return null;

      chatLock.current = true;
      setChatBusy(true);
      setChatDraft('');
      setError(null);
      setRunning(true);
      setCurrentStepId(null);
      setVisibleLogs([]);

      const now = Date.now();
      const userTurn: ChatTurn = {
        id: randomId(),
        role: 'user',
        text,
        at: now,
      };
      const agentTurnId = randomId();
      const agentTurn: ChatTurn = {
        id: agentTurnId,
        role: 'agent',
        text: '',
        at: now,
        working: true,
      };
      setChat((current) => [...current, userTurn, agentTurn]);

      try {
        const response = await fetch('/api/agent/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workflowId: target.id,
            message: text,
            // 会话 ID 由服务端首次生成后回传，之后每轮原样带回 → n8n 侧 Memory 才能接上上下文
            sessionId: sessionIdRef.current ?? undefined,
            apiKey: llmConfig.apiKey.trim() || undefined,
            provider: llmConfig.provider,
            baseUrl: llmConfig.baseUrl.trim() || undefined,
            model: llmConfig.model.trim() || undefined,
          }),
        });
        const data = (await response.json()) as AgentChatResponse & {
          error?: string;
        };
        if (data.sessionId) {
          sessionIdRef.current = data.sessionId;
        }
        if (!response.ok || !data.run) {
          throw new Error(data.error ?? 'Agent 暂时没有回应。');
        }

        for (let index = 0; index < data.run.logs.length; index += 1) {
          const log = data.run.logs[index];
          setChatProgress({ turnId: agentTurnId, message: log.message });
          setVisibleLogs(data.run.logs.slice(0, index + 1));
          setCurrentStepId(log.stepId ?? null);
          await wait(index === 0 ? 260 : 480);
        }

        lastReplyRef.current = data.reply;
        setChatProgress(null);
        setCurrentStepId(null);
        setChat((current) =>
          current.map((turn) =>
            turn.id === agentTurnId
              ? {
                  ...turn,
                  working: false,
                  text: data.reply,
                  runId: data.run.id,
                  intent: data.intent,
                  priority: data.priority,
                  mode: data.mode,
                  executionMode: data.executionMode,
                  degraded: data.degraded,
                }
              : turn,
          ),
        );
        setActiveRun(data.run);
        setRuns((current) => [data.run, ...current].slice(0, 8));
        return data.run;
      } catch (cause) {
        setChat((current) => current.filter((turn) => turn.id !== agentTurnId));
        setError(
          cause instanceof Error
            ? cause.message
            : 'Agent 暂时没有回应，请重试。',
        );
        return null;
      } finally {
        chatLock.current = false;
        setChatBusy(false);
        setRunning(false);
      }
    },
    [chatDraft, workflows, consumerWorkflowId, llmConfig],
  );

  useEffect(() => {
    workflowsRef.current = workflows;
  }, [workflows]);

  useEffect(() => {
    consumerWorkflowIdRef.current = consumerWorkflowId;
  }, [consumerWorkflowId]);

  useEffect(() => {
    runActionRef.current = startRun;
  }, [startRun]);

  useEffect(() => {
    chatActionRef.current = sendChatMessage;
  }, [sendChatMessage]);

  const resetConsumerSession = useCallback(() => {
    setChat([]);
    setChatProgress(null);
    setActiveRun(null);
    setVisibleLogs([]);
    setCurrentStepId(null);
  }, []);

  const selectConsumerWorkflow = useCallback(
    (id: string) => {
      if (consumerWorkflowIdRef.current === id) return;
      consumerWorkflowIdRef.current = id;
      setConsumerWorkflowId(id);
      resetConsumerSession();
    },
    [resetConsumerSession],
  );

  useEffect(() => {
    selectConsumerWorkflowRef.current = selectConsumerWorkflow;
  }, [selectConsumerWorkflow]);

  useEffect(() => {
    const node = chatListRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [chat, chatProgress]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;

    const lifecycle = new AbortController();
    const reportRegistrationError = (cause: unknown) => {
      console.error('WebMCP tool registration failed', cause);
    };

    try {
      void Promise.resolve(
        context.registerTool(
          {
            name: 'read_workflow_state',
            title: '读取工作流状态',
            description:
              '读取当前所有工作流的草稿、发布版本和最近运行数量，不修改任何数据。',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
            annotations: {
              readOnlyHint: true,
              untrustedContentHint: false,
            },
            async execute() {
              const response = await fetch('/api/state', { cache: 'no-store' });
              if (!response.ok) throw new Error('无法读取工作流状态。');
              const state = (await response.json()) as StateResponse;
              setWorkflows(state.workflows);
              workflowsRef.current = state.workflows;
              setRuns(state.runs);
              return {
                workflows: state.workflows.map((item) => ({
                  id: item.id,
                  name: item.name,
                  version: item.version,
                  published: Boolean(item.publishedSteps),
                  hasUnpublishedChanges: item.hasUnpublishedChanges,
                })),
                recentRunCount: state.runs.length,
              };
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(reportRegistrationError);

      void Promise.resolve(
        context.registerTool(
          {
            name: 'run_published_workflow',
            title: '运行已发布工作流',
            description:
              '在使用工作流端运行指定的已发布工作流，并在界面中显示执行步骤、日志和结果。',
            inputSchema: {
              type: 'object',
              properties: {
                workflowId: {
                  type: 'string',
                  description: '由 read_workflow_state 返回的工作流编号。',
                },
              },
              required: ['workflowId'],
              additionalProperties: false,
            },
            annotations: {
              readOnlyHint: false,
              untrustedContentHint: false,
            },
            async execute(input) {
              if (
                !input ||
                typeof input !== 'object' ||
                typeof (input as { workflowId?: unknown }).workflowId !==
                  'string'
              ) {
                throw new Error('workflowId 必须是字符串。');
              }
              const workflowId = (input as { workflowId: string }).workflowId;
              const target = workflowsRef.current.find(
                (item) => item.id === workflowId,
              );
              if (!target) {
                throw new Error('找不到这个工作流，请先读取最新状态。');
              }
              if (!target.publishedSteps) {
                throw new Error('该工作流尚未发布。');
              }
              setPortal('consumer');
              selectConsumerWorkflowRef.current(workflowId);
              const run = await runActionRef.current(workflowId);
              if (!run) throw new Error('工作流未能启动。');
              return {
                runId: run.id,
                status: run.status,
                workflowVersion: run.workflowVersion,
                processedSteps: run.output.processed,
                result: run.output.result,
              };
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(reportRegistrationError);

      void Promise.resolve(
        context.registerTool(
          {
            name: 'chat_with_agent',
            title: '与 Agent 对话',
            description:
              '向使用工作流端的 Agent 发送一条消息，Agent 按指定（或当前装载）的已发布工作流逐步处理并回复，界面会切换到使用端展示对话。',
            inputSchema: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: '要发送给 Agent 的消息内容。',
                },
                workflowId: {
                  type: 'string',
                  description:
                    '可选：指定已发布工作流的编号；缺省使用当前装载的工作流。',
                },
              },
              required: ['message'],
              additionalProperties: false,
            },
            annotations: {
              readOnlyHint: false,
              untrustedContentHint: false,
            },
            async execute(input) {
              if (
                !input ||
                typeof input !== 'object' ||
                typeof (input as { message?: unknown }).message !== 'string'
              ) {
                throw new Error('message 必须是字符串。');
              }
              const body = input as { message: string; workflowId?: unknown };
              const workflowId =
                typeof body.workflowId === 'string' && body.workflowId
                  ? body.workflowId
                  : consumerWorkflowIdRef.current;
              if (!workflowId) {
                throw new Error('当前没有已发布的工作流可以对话。');
              }
              const target = workflowsRef.current.find(
                (item) => item.id === workflowId,
              );
              if (!target?.publishedSteps) {
                throw new Error('该工作流不存在或尚未发布。');
              }
              setPortal('consumer');
              selectConsumerWorkflowRef.current(workflowId);
              const run = await chatActionRef.current(body.message, workflowId);
              if (!run) throw new Error('Agent 未能回应。');
              return {
                runId: run.id,
                workflowVersion: run.workflowVersion,
                intent: run.output.summary,
                reply: lastReplyRef.current,
              };
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(reportRegistrationError);
    } catch (cause) {
      reportRegistrationError(cause);
    }

    return () => lifecycle.abort();
  }, []);

  const greetingTurn: ChatTurn = useMemo(
    () => ({
      id: 'agent-greeting',
      role: 'agent',
      text: consumerWorkflow?.publishedSteps
        ? `你好，我是装载「${consumerWorkflow.name}」v${consumerWorkflow.version} 的 Agent。把你的请求直接发给我，我会按这套步骤处理并回复。`
        : '你好，我是 Urtoris Agent。当前没有已发布的工作流可以装载，请先在创建端发布一个版本。',
      at: 0,
    }),
    [consumerWorkflow],
  );
  const visibleChat = chat.length ? chat : [greetingTurn];

  const latestRun =
    activeRun ??
    runs.find((run) => run.workflowId === consumerWorkflowId) ??
    null;
  const logs = running ? visibleLogs : (latestRun?.logs ?? []);
  const runMatchesVersion =
    latestRun?.workflowVersion === (consumerWorkflow?.version ?? -1);
  const serviceLabel =
    loadState === 'loading'
      ? '正在连接'
      : loadState === 'error'
        ? '连接异常'
        : '服务已联通';

  const currentStepIndex = useMemo(
    () => publishedSteps?.findIndex((step) => step.id === currentStepId) ?? -1,
    [currentStepId, publishedSteps],
  );

  const stepState = (step: WorkflowStep, index: number) => {
    if (running && runMatchesVersion) {
      if (step.id === currentStepId) return 'running';
      if (currentStepIndex > index) return 'completed';
      return 'queued';
    }
    if (runMatchesVersion && latestRun?.status === 'completed')
      return 'completed';
    return 'queued';
  };

  const copyApiAddress = async () => {
    const address = `${window.location.origin}/api/v1/run`;
    try {
      // 剪贴板 API 同样要求安全上下文：HTTP + 公网 IP 部署下它是 undefined。
      // 这里不去动用已废弃的 execCommand，而是如实把地址显示出来让用户手动复制。
      if (!navigator.clipboard?.writeText) {
        setError(`当前环境不支持自动复制，请手动复制接口地址：${address}`);
        return;
      }
      await navigator.clipboard.writeText(address);
      setApiCopied(true);
      setTimeout(() => setApiCopied(false), 1600);
    } catch {
      setError(`接口地址：${address}`);
    }
  };

  return (
    <div className="urtoris-shell">
      <header className="urtoris-header">
        <button
          type="button"
          className="brand-lockup brand-button"
          aria-label="返回端口选择"
          onClick={() => setPortal('gateway')}
        >
          <span className="brand-mark" aria-hidden="true">
            <WorkflowIcon />
          </span>
          <span>Urtoris</span>
        </button>

        <p className="header-title">
          {portal === 'gateway'
            ? '工作流双端入口'
            : portal === 'creator'
              ? '创建工作流端'
              : '使用工作流端'}
        </p>

        <div
          className="connection-state"
          aria-label={`连接状态：${serviceLabel}`}
        >
          <Wifi aria-hidden="true" />
          <span>{serviceLabel}</span>
          <span
            className={`connection-dot connection-dot-${loadState}`}
            aria-hidden="true"
          />
        </div>
      </header>

      {portal === 'gateway' ? (
        <main className="portal-gateway">
          <section className="gateway-frame" aria-labelledby="gateway-title">
            <div className="gateway-intro">
              <div>
                <span className="gateway-brand-mark" aria-hidden="true">
                  <WorkflowIcon />
                </span>
                <h1 id="gateway-title" ref={gatewayTitleRef} tabIndex={-1}>
                  选择你要进入的工作端
                </h1>
                <p>
                  创建端负责编排和发布多个工作流，使用端选择已发布版本装载给
                  Agent 对话并查看执行结果。
                </p>
              </div>
              <div className="gateway-connection">
                <span className="connection-dot" aria-hidden="true" />
                两个端共享同一批已发布工作流
              </div>
            </div>

            <div className="portal-choice-list" aria-label="选择工作端">
              <Link
                href="/studio"
                className="portal-choice portal-choice-creator"
              >
                <span className="portal-choice-icon" aria-hidden="true">
                  <WorkflowIcon />
                </span>
                <span className="portal-choice-copy">
                  <strong>创建工作流端</strong>
                  <span>设计步骤、保存草稿，并发布可供调用的版本。</span>
                  <small>
                    {loadState === 'loading'
                      ? '正在读取工作流'
                      : loadState === 'error'
                        ? '暂时无法读取工作流'
                        : workflows.length
                          ? `${workflows.length} 个工作流 · ${publishedWorkflows.length} 个已发布`
                          : '还没有工作流，进入创建端开始'}
                  </small>
                </span>
                <span className="portal-choice-action">
                  进入创建端 <ArrowRight aria-hidden="true" />
                </span>
              </Link>

              <button
                type="button"
                className="portal-choice portal-choice-consumer"
                onClick={() => setPortal('consumer')}
              >
                <span className="portal-choice-icon" aria-hidden="true">
                  <Bot />
                </span>
                <span className="portal-choice-copy">
                  <strong>使用工作流端</strong>
                  <span>选择已发布版本装载给 Agent，对话并查看运行结果。</span>
                  <small>
                    {loadState === 'loading'
                      ? '正在读取可用版本'
                      : loadState === 'error'
                        ? '暂时无法读取可用版本'
                        : publishedWorkflows.length
                          ? `${publishedWorkflows.length} 个已发布版本可装载`
                          : '正在等待首个发布版本'}
                  </small>
                </span>
                <span className="portal-choice-action">
                  进入使用端 <ArrowRight aria-hidden="true" />
                </span>
              </button>
            </div>
          </section>
          {loadState === 'error' ? (
            <div className="gateway-error" role="alert">
              <span>暂时无法连接工作流服务。</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void refreshState()}
              >
                重试连接
              </Button>
            </div>
          ) : (
            <p className="gateway-footnote">
              当前为功能原型，暂不需要账号密码。
            </p>
          )}
        </main>
      ) : (
        <main id="workspace" className="urtoris-workspace">
          <nav className="portal-toolbar" aria-label="当前工作端">
            <Button
              type="button"
              variant="ghost"
              className="back-to-gateway"
              onClick={() => setPortal('gateway')}
            >
              <ChevronLeft data-icon="inline-start" />
              切换工作端
            </Button>
            <div className="portal-current">
              {portal === 'creator' ? <WorkflowIcon /> : <Bot />}
              <span>
                <small>当前身份</small>
                <strong>
                  {portal === 'creator' ? '工作流创建者' : '工作流使用者'}
                </strong>
              </span>
            </div>
          </nav>

          {error ? (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setError(null)}
              >
                知道了
              </Button>
            </div>
          ) : null}

          <div className={`workflow-map workflow-map-${portal}`}>
            {portal === 'creator' ? (
              <section
                className="workbench-panel creator-panel"
                aria-labelledby="creator-title"
              >
                <header className="panel-heading">
                  <div>
                    <h1 id="creator-title" ref={creatorTitleRef} tabIndex={-1}>
                      创建工作流端
                    </h1>
                    <p>编排步骤，形成可被使用端装载并调用的版本。</p>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      workflow.hasUnpublishedChanges
                        ? 'state-stamp state-stamp-draft'
                        : 'state-stamp state-stamp-ready'
                    }
                  >
                    {workflow.hasUnpublishedChanges
                      ? '有未发布更改'
                      : `已发布 v${workflow.version}`}
                  </Badge>
                </header>

                <div className="workflow-switcher">
                  <label htmlFor="creator-workflow-select">当前工作流</label>
                  <NativeSelect
                    id="creator-workflow-select"
                    className="workflow-select"
                    size="sm"
                    value={workflow.id}
                    onChange={(event) =>
                      setCreatorWorkflowId(event.target.value)
                    }
                  >
                    {editableWorkflows.map((item) => (
                      <NativeSelectOption value={item.id} key={item.id}>
                        {item.name.trim() || '未命名工作流'}
                        {item.publishedSteps ? ` · v${item.version}` : ''}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="new-workflow-button"
                    onClick={() => void createNewWorkflow()}
                  >
                    <CirclePlus data-icon="inline-start" />
                    新建
                  </Button>
                </div>

                <div className="manifest-fields">
                  <label htmlFor="workflow-name">工作流名称</label>
                  <Input
                    id="workflow-name"
                    className="manifest-name-input"
                    value={workflow.name}
                    onChange={(event) =>
                      markChanged({ name: event.target.value })
                    }
                    maxLength={80}
                  />
                  <label htmlFor="workflow-description">用途说明</label>
                  <Textarea
                    id="workflow-description"
                    className="manifest-description-input"
                    value={workflow.description}
                    onChange={(event) =>
                      markChanged({ description: event.target.value })
                    }
                    maxLength={240}
                    rows={2}
                  />
                  <label htmlFor="workflow-n8n-url">n8n webhook</label>
                  <Input
                    id="workflow-n8n-url"
                    className="manifest-name-input engine-input"
                    value={workflow.n8nWebhookUrl ?? ''}
                    onChange={(event) =>
                      markChanged({
                        n8nWebhookUrl: event.target.value || null,
                      })
                    }
                    placeholder="http://127.0.0.1:5678/webhook/xxxx"
                    spellCheck={false}
                  />
                  <p className="field-note">
                    填入后，这个工作流在使用端的「运行」和「对话」会真的 POST
                    到这个 n8n webhook，并把 n8n
                    的返回写进运行记录；留空则退回内置模拟执行器。
                  </p>
                  <p className="field-note">
                    Webhook 鉴权统一由服务端的 N8N_WEBHOOK_TOKEN 提供，
                    不在浏览器或工作流数据中保存令牌。
                  </p>
                  <label htmlFor="workflow-admin-token">
                    管理员令牌（仅保存在当前浏览器会话）
                  </label>
                  <Input
                    id="workflow-admin-token"
                    className="manifest-name-input engine-input"
                    type="password"
                    value={adminToken}
                    onChange={(event) => setAdminToken(event.target.value)}
                    placeholder={
                      adminTrusted
                        ? '本机/内网访问，可留空'
                        : '输入 URTORIS_ADMIN_TOKEN'
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <p className="field-note">
                    {adminTrusted
                      ? '当前是本机/内网访问，服务端已把这次会话当管理员，保存与发布都不用填令牌。'
                      : '公网部署下保存草稿、发布版本需要这个令牌。'}
                  </p>
                </div>

                <div className="step-list-heading">
                  <h2>执行顺序</h2>
                  <span>{workflow.draftSteps.length} 个步骤</span>
                </div>

                <div className="step-list" aria-label="工作流步骤">
                  {workflow.draftSteps.map((step, index) => (
                    <article className="step-ticket" key={step.id}>
                      <span
                        className="step-number"
                        aria-label={`第 ${index + 1} 步`}
                      >
                        {String(index + 1).padStart(2, '0')}
                      </span>

                      <div className="step-ticket-body">
                        <label className="sr-only" htmlFor={`${step.id}-title`}>
                          第 {index + 1} 步名称
                        </label>
                        <Input
                          id={`${step.id}-title`}
                          className="step-title-input"
                          value={step.title}
                          onChange={(event) =>
                            updateStep(step.id, { title: event.target.value })
                          }
                          maxLength={80}
                        />
                        <div className="step-ticket-meta">
                          <label
                            className="sr-only"
                            htmlFor={`${step.id}-kind`}
                          >
                            第 {index + 1} 步类型
                          </label>
                          <NativeSelect
                            id={`${step.id}-kind`}
                            className="step-kind-select"
                            size="sm"
                            value={step.kind}
                            onChange={(event) =>
                              updateStep(step.id, {
                                kind: event.target.value as StepKind,
                              })
                            }
                          >
                            {Object.entries(kindLabels).map(([kind, label]) => (
                              <NativeSelectOption value={kind} key={kind}>
                                {label}
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                          <label
                            className="sr-only"
                            htmlFor={`${step.id}-detail`}
                          >
                            第 {index + 1} 步说明
                          </label>
                          <Input
                            id={`${step.id}-detail`}
                            className="step-detail-input"
                            value={step.detail}
                            onChange={(event) =>
                              updateStep(step.id, {
                                detail: event.target.value,
                              })
                            }
                            maxLength={180}
                          />
                        </div>
                      </div>

                      <div
                        className="step-actions"
                        aria-label={`调整第 ${index + 1} 步`}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label="上移"
                          title="上移"
                          disabled={index === 0}
                          onClick={() => moveStep(index, -1)}
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label="下移"
                          title="下移"
                          disabled={index === workflow.draftSteps.length - 1}
                          onClick={() => moveStep(index, 1)}
                        >
                          <ArrowDown />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="delete-step"
                          aria-label="删除步骤"
                          title="删除步骤"
                          onClick={() => removeStep(step.id)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  className="add-step-button"
                  onClick={addStep}
                >
                  <CirclePlus data-icon="inline-start" />
                  添加步骤
                </Button>

                <footer className="creator-actions">
                  <Button
                    type="button"
                    variant="outline"
                    className="secondary-action"
                    disabled={saveState === 'saving'}
                    onClick={() => void persistWorkflow('save')}
                  >
                    {saveState === 'saving' ? (
                      <Loader2 className="spin" data-icon="inline-start" />
                    ) : saveState === 'saved' ? (
                      <Check data-icon="inline-start" />
                    ) : (
                      <Save data-icon="inline-start" />
                    )}
                    {saveState === 'saving'
                      ? '正在保存'
                      : saveState === 'saved'
                        ? '已保存'
                        : '保存草稿'}
                  </Button>
                  <Button
                    type="button"
                    className="publish-action"
                    disabled={saveState === 'saving'}
                    onClick={() => void persistWorkflow('publish')}
                  >
                    <Send data-icon="inline-start" />
                    发布到使用端
                  </Button>
                </footer>
              </section>
            ) : (
              <section
                className="workbench-panel consumer-panel"
                aria-labelledby="consumer-title"
              >
                <header className="panel-heading">
                  <div>
                    <h1
                      id="consumer-title"
                      ref={consumerTitleRef}
                      tabIndex={-1}
                    >
                      使用工作流端
                    </h1>
                    <p>选择已发布版本装载给 Agent，对话并查看回传结果。</p>
                  </div>
                  <Badge
                    variant="outline"
                    className="state-stamp state-stamp-online"
                  >
                    <Bot /> Agent 已连接
                  </Badge>
                </header>

                <div className="received-heading">
                  <h2>可用工作流</h2>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="刷新数据"
                    title="刷新数据"
                    disabled={loadState === 'loading'}
                    onClick={() => void refreshState()}
                  >
                    <RefreshCw
                      className={loadState === 'loading' ? 'spin' : ''}
                    />
                  </Button>
                </div>

                {publishedWorkflows.length ? (
                  <div className="workflow-switcher consumer-switcher">
                    <label htmlFor="consumer-workflow-select">
                      Agent 装载的工作流
                    </label>
                    <NativeSelect
                      id="consumer-workflow-select"
                      className="workflow-select"
                      size="sm"
                      value={consumerWorkflowId ?? ''}
                      onChange={(event) =>
                        selectConsumerWorkflow(event.target.value)
                      }
                    >
                      {publishedWorkflows.map((item) => (
                        <NativeSelectOption value={item.id} key={item.id}>
                          {item.name} · v{item.version}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>
                ) : null}

                {consumerWorkflow?.publishedSteps ? (
                  <div className="received-manifest">
                    <div>
                      <strong>{consumerWorkflow.name}</strong>
                      <p>{consumerWorkflow.description}</p>
                    </div>
                    <div className="received-tags">
                      <span className="version-stamp">
                        VERSION {consumerWorkflow.version}
                      </span>
                      {consumerWorkflow.n8nWebhookUrl ? (
                        <span className="engine-tag engine-tag-n8n">
                          <Zap aria-hidden="true" />
                          n8n 引擎
                        </span>
                      ) : (
                        <span className="engine-tag">内置模拟</span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="empty-manifest">
                    <CircleDashed aria-hidden="true" />
                    <div>
                      <strong>还没有可用版本</strong>
                      <p>请先在创建工作流端发布一个版本，再装载给 Agent。</p>
                    </div>
                  </div>
                )}

                <section className="llm-panel" aria-label="Agent 模型设置">
                  <button
                    type="button"
                    className="llm-panel-head"
                    aria-expanded={llmPanelOpen}
                    onClick={() => setLlmPanelOpen((current) => !current)}
                  >
                    <div>
                      <h3>
                        <KeyRound aria-hidden="true" />
                        自带模型 Key
                        {llmConfig.apiKey.trim() ? (
                          <span className="llm-state llm-state-on">
                            真实模型已启用
                          </span>
                        ) : loadedUsesN8n ? (
                          <span className="llm-state llm-state-on">
                            已接入 n8n 引擎
                          </span>
                        ) : (
                          <span className="llm-state llm-state-off">
                            当前为模拟回复
                          </span>
                        )}
                      </h3>
                      <p>
                        填入你自己的大模型 API Key，Agent 就会真的调用模型；Key
                        只留在这个浏览器里。
                      </p>
                    </div>
                    {llmPanelOpen ? (
                      <ArrowUp aria-hidden="true" />
                    ) : (
                      <ArrowDown aria-hidden="true" />
                    )}
                  </button>

                  {llmPanelOpen ? (
                    <div className="llm-panel-body">
                      <div className="llm-field">
                        <label htmlFor="llm-provider">模型服务</label>
                        <NativeSelect
                          id="llm-provider"
                          className="workflow-select"
                          size="sm"
                          value={llmConfig.provider}
                          onChange={(event) => {
                            const next = providerDefaults(event.target.value);
                            if (!next) return;
                            setLlmConfig((current) => ({
                              ...current,
                              provider: next.id,
                              baseUrl: next.baseUrl,
                              model: next.model,
                            }));
                          }}
                        >
                          {providerOptions().map((option) => (
                            <NativeSelectOption
                              key={option.id}
                              value={option.id}
                            >
                              {option.vendor} · {option.label}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </div>
                      <div className="llm-field">
                        <label htmlFor="llm-api-key">API Key</label>
                        <Input
                          id="llm-api-key"
                          type="password"
                          value={llmConfig.apiKey}
                          onChange={(event) =>
                            setLlmConfig((current) => ({
                              ...current,
                              apiKey: event.target.value,
                            }))
                          }
                          placeholder={
                            providerOptions().find(
                              (option) => option.id === llmConfig.provider,
                            )?.keyHint ?? 'sk-...'
                          }
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </div>
                      <div className="llm-field">
                        <label htmlFor="llm-base-url">
                          Base URL
                        </label>
                        <Input
                          id="llm-base-url"
                          value={llmConfig.baseUrl}
                          placeholder={
                            providerOptions().find(
                              (option) => option.id === llmConfig.provider,
                            )?.defaultBaseUrl || 'https://你的网关/v1'
                          }
                          onChange={(event) =>
                            setLlmConfig((current) => ({
                              ...current,
                              baseUrl: event.target.value,
                            }))
                          }
                          spellCheck={false}
                        />
                      </div>
                      <div className="llm-field">
                        <label htmlFor="llm-model">模型名</label>
                        <Input
                          id="llm-model"
                          list="llm-model-list"
                          value={llmConfig.model}
                          placeholder={
                            providerOptions().find(
                              (option) => option.id === llmConfig.provider,
                            )?.defaultModel || '例如 gpt-4o-mini'
                          }
                          onChange={(event) =>
                            setLlmConfig((current) => ({
                              ...current,
                              model: event.target.value,
                            }))
                          }
                          spellCheck={false}
                        />
                        <datalist id="llm-model-list">
                          {(
                            providerOptions().find(
                              (option) => option.id === llmConfig.provider,
                          )?.models ?? []
                          ).map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))}
                        </datalist>
                      </div>
                      <p className="llm-note">
                        先选模型服务，再填该服务商签发的 Key：通义千问 / OpenAI /
                        DeepSeek / Kimi / 智谱 / Claude / Gemini / 本机
                        Ollama 都有预置端点，自建网关选「自定义」填 Base
                        URL。Key 只存在浏览器 localStorage，
                        随请求发给服务端用完即弃，不写入数据库、不进代码库。
                      </p>
                      <div className="llm-actions">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setLlmConfig((current) => ({
                              ...current,
                              apiKey: '',
                            }))
                          }
                        >
                          清除 Key（回到模拟）
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setLlmConfig((current) => ({
                              ...current,
                              ...(providerDefaults(current.provider) ?? {
                                baseUrl: defaultLlmConfig.baseUrl,
                                model: defaultLlmConfig.model,
                              }),
                            }))
                          }
                        >
                          恢复该服务默认值
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </section>

                <section
                  className="agent-chat"
                  aria-labelledby="agent-chat-title"
                >
                  <header className="agent-chat-heading">
                    <div>
                      <h2 id="agent-chat-title">与 Agent 对话</h2>
                      <p>
                        {consumerWorkflow?.publishedSteps
                          ? `已装载「${consumerWorkflow.name}」v${consumerWorkflow.version}，消息会按这套步骤执行。`
                          : '等待装载已发布工作流。'}
                      </p>
                    </div>
                    <span className="agent-chat-status">
                      <span className="connection-dot" aria-hidden="true" />
                      {chatBusy
                        ? '处理中'
                        : loadedUsesN8n
                          ? 'n8n 引擎'
                          : llmConfig.apiKey.trim()
                            ? '真实模型'
                            : '模拟模式'}
                    </span>
                  </header>

                  <div
                    className="chat-stream"
                    ref={chatListRef}
                    aria-live="polite"
                  >
                    {visibleChat.map((turn) => (
                      <article
                        className={`chat-turn chat-turn-${turn.role}`}
                        key={turn.id}
                      >
                        <span className="chat-avatar" aria-hidden="true">
                          {turn.role === 'agent' ? <Bot /> : '我'}
                        </span>
                        <div className="chat-bubble">
                          {turn.role === 'agent' && turn.working ? (
                            <span className="chat-working">
                              <Loader2 className="spin" aria-hidden="true" />
                              {chatProgress?.turnId === turn.id
                                ? chatProgress.message
                                : 'Agent 正在准备…'}
                            </span>
                          ) : (
                            <>
                              <p className="chat-text">{turn.text}</p>
                              {turn.runId ? (
                                <span className="chat-meta">
                                  {turn.intent} · {turn.priority}优先级 · RUN{' '}
                                  {turn.runId.slice(0, 8)}
                                  {turn.mode === 'n8n' ? (
                                    <span
                                      className={`engine-tag ${
                                        turn.degraded
                                          ? 'engine-tag-degraded'
                                          : 'engine-tag-model'
                                      }`}
                                    >
                                      <Zap aria-hidden="true" />
                                      {turn.degraded
                                        ? 'n8n · 规则降级'
                                        : turn.executionMode === 'llm'
                                          ? 'n8n · 真实模型'
                                          : 'n8n · 规则'}
                                    </span>
                                  ) : turn.mode === 'model' ? (
                                    <span className="engine-tag engine-tag-model">
                                      <Zap aria-hidden="true" />
                                      真实模型
                                    </span>
                                  ) : (
                                    <span className="engine-tag">模拟回复</span>
                                  )}
                                </span>
                              ) : null}
                            </>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>

                  <div className="chat-prompts" aria-label="示例请求">
                    {quickPrompts.map((prompt) => (
                      <button
                        type="button"
                        key={prompt}
                        disabled={!publishedSteps || chatBusy || running}
                        onClick={() => void sendChatMessage(prompt)}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>

                  <form
                    className="chat-composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void sendChatMessage();
                    }}
                  >
                    <label className="sr-only" htmlFor="agent-chat-input">
                      给 Agent 发消息
                    </label>
                    <Input
                      id="agent-chat-input"
                      className="chat-input"
                      value={chatDraft}
                      onChange={(event) => setChatDraft(event.target.value)}
                      placeholder={
                        publishedSteps
                          ? '把请求发给 Agent，例如「我的订单三天了还没发货」'
                          : '等待装载已发布工作流…'
                      }
                      maxLength={2000}
                      autoComplete="off"
                      disabled={!publishedSteps || chatBusy}
                    />
                    <Button
                      type="submit"
                      className="chat-send"
                      disabled={
                        !publishedSteps ||
                        chatBusy ||
                        running ||
                        !chatDraft.trim()
                      }
                    >
                      {chatBusy ? (
                        <Loader2 className="spin" data-icon="inline-start" />
                      ) : (
                        <Send data-icon="inline-start" />
                      )}
                      发送
                    </Button>
                  </form>
                </section>

                <section
                  className="api-access"
                  aria-labelledby="api-access-title"
                >
                  <header>
                    <div>
                      <h2 id="api-access-title">API 接入</h2>
                      <p>外部程序可用密钥触发指定工作流。</p>
                    </div>
                    <span>POST</span>
                  </header>
                  <div className="api-endpoint">
                    <code>/api/v1/run</code>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void copyApiAddress()}
                    >
                      {apiCopied ? (
                        <Check data-icon="inline-start" />
                      ) : (
                        <Copy data-icon="inline-start" />
                      )}
                      {apiCopied ? '已复制' : '复制地址'}
                    </Button>
                  </div>
                  <details className="api-example">
                    <summary>查看请求格式</summary>
                    <pre>{`Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{"workflowId":"${consumerWorkflow?.id ?? '…'}","input":{}}`}</pre>
                  </details>
                </section>

                <Button
                  type="button"
                  className="run-action"
                  disabled={!publishedSteps || running || chatBusy}
                  onClick={() => void startRun()}
                >
                  {running ? (
                    <Loader2 className="spin" data-icon="inline-start" />
                  ) : (
                    <Play data-icon="inline-start" />
                  )}
                  {chatBusy
                    ? 'Agent 正在对话执行'
                    : running
                      ? 'Agent 正在执行'
                      : '运行当前工作流'}
                </Button>

                <div className="agent-route-heading">
                  <h2>Agent 执行路线</h2>
                  <span>{running ? '运行中' : '等待任务'}</span>
                </div>

                <ol className="agent-route">
                  {(publishedSteps ?? []).map((step, index) => {
                    const state = stepState(step, index);
                    return (
                      <li
                        className={`route-step route-step-${state}`}
                        key={step.id}
                      >
                        <span className="route-state" aria-hidden="true">
                          {state === 'completed' ? (
                            <CheckCircle2 />
                          ) : state === 'running' ? (
                            <Loader2 className="spin" />
                          ) : (
                            <span />
                          )}
                        </span>
                        <span className="route-index">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <span className="route-name">{step.title}</span>
                        <span className="route-kind">
                          {kindLabels[step.kind]}
                        </span>
                      </li>
                    );
                  })}
                </ol>

                <div className="run-log-heading">
                  <h2>运行记录</h2>
                  <span>
                    {latestRun ? `RUN ${latestRun.id.slice(0, 8)}` : '暂无记录'}
                  </span>
                </div>
                <output
                  className="run-log"
                  aria-live="polite"
                  aria-atomic="false"
                >
                  {logs.length ? (
                    logs.map((log, index) => (
                      <span
                        className={`log-line log-${log.level}`}
                        key={`${log.at}-${index}`}
                      >
                        <time>{formatClock(log.at)}</time>
                        <span>{log.message}</span>
                      </span>
                    ))
                  ) : (
                    <span className="log-empty">
                      对话或运行后，Agent 的每一步会在这里留下记录。
                    </span>
                  )}
                </output>

                {latestRun?.status === 'completed' && !running ? (
                  <div className="result-strip">
                    <CheckCircle2 aria-hidden="true" />
                    <div>
                      <strong>{latestRun.output.result}</strong>
                      <span>{latestRun.output.summary}</span>
                    </div>
                    <time>{formatClock(latestRun.finishedAt)}</time>
                  </div>
                ) : null}
              </section>
            )}
          </div>

          {portal === 'consumer' ? (
            <section className="run-history" aria-labelledby="history-title">
              <div className="history-heading">
                <div>
                  <h2 id="history-title">最近运行</h2>
                  <p>对话与手动运行都会留下记录，来自本地持久化数据。</p>
                </div>
                <span className="demo-label">演示数据</span>
              </div>
              {runs.length ? (
                <div className="history-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>工作流</th>
                        <th>版本</th>
                        <th>开始时间</th>
                        <th>步骤</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.slice(0, 5).map((run) => (
                        <tr key={run.id}>
                          <td>{run.workflowName}</td>
                          <td className="tabular">v{run.workflowVersion}</td>
                          <td className="tabular">
                            {formatClock(run.startedAt)}
                          </td>
                          <td className="tabular">{run.steps.length}</td>
                          <td>
                            <span
                              className={`history-status ${
                                run.degraded ? 'history-status-degraded' : ''
                              }`}
                            >
                              <CheckCircle2 />
                              {run.status === 'failed'
                                ? '失败'
                                : run.degraded
                                  ? '成功（规则降级）'
                                  : run.mode === 'llm'
                                    ? '成功（真实模型）'
                                    : '已完成'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="history-empty">
                  完成第一次对话或运行后，这里会出现记录。
                </p>
              )}
            </section>
          ) : null}
        </main>
      )}
    </div>
  );
}
