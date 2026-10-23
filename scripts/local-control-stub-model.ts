import { createServer } from 'node:http';

/**
 * 本机全权限模式的确定性模型替身。
 *
 * 它只实现 OpenAI 兼容的 `/chat/completions`，按固定剧本走两轮：
 *
 * 1. 第一轮返回一个 `run_shell` 工具调用（命令从环境变量取，默认只做只读检查）。
 * 2. 第二轮（收到 tool 结果后）把结果原样念回去。
 *
 * 用途是把「浏览器 → 站点 Agent → 本机 Control Agent → zsh」这条链路整条跑通，
 * 不依赖任何外部模型 Key。它**不是**模型能力验证：真实的 tool calls 必须另外用
 * 一次性 Key 复核。
 *
 *   node --import tsx scripts/local-control-stub-model.ts
 */

const port = Number(process.env.LOCAL_CONTROL_STUB_MODEL_PORT ?? 3021);
const host = process.env.LOCAL_CONTROL_STUB_MODEL_HOST ?? '127.0.0.1';
const command = process.env.LOCAL_CONTROL_STUB_COMMAND ?? "pwd; id -u; whoami";

type StubMessage = { role?: string; content?: unknown };

function readText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (!part || typeof part !== 'object' || !('text' in part)) return '';
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }
  return '';
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'stub-local-control' }] }));
    return;
  }
  if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }

  let raw = '';
  request.on('data', (chunk) => {
    raw += chunk;
  });
  request.on('end', () => {
    let messages: StubMessage[] = [];
    try {
      const payload = JSON.parse(raw) as { messages?: StubMessage[] };
      messages = Array.isArray(payload.messages) ? payload.messages : [];
    } catch {
      // 落到下面的兜底分支。
    }

    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => readText(message.content))
      .join('\n');
    const taskId = /localtask_[a-f0-9]{32}/.exec(system)?.[0] ?? '';
    const toolMessages = messages.filter((message) => message.role === 'tool');

    let message: Record<string, unknown>;
    if (toolMessages.length > 0) {
      const last = readText(toolMessages[toolMessages.length - 1]?.content);
      message = {
        role: 'assistant',
        content: `本机命令已执行完毕。工具返回：${last.slice(0, 1_200)}`,
      };
    } else {
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_stub_1',
            type: 'function',
            function: {
              name: 'run_shell',
              arguments: JSON.stringify({
                protocol: 'urtoris.local-control.v1',
                task_id: taskId,
                idempotency_key: 'stub-step-1',
                command,
                reason: '本机确定性模型替身：只读检查当前用户与目录',
                timeout_seconds: 60,
              }),
            },
          },
        ],
      };
    }

    console.log(
      `[stub-model] turn=${toolMessages.length > 0 ? 2 : 1} task=${taskId || '(missing)'}`,
    );
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'stub-completion',
        object: 'chat.completion',
        model: 'stub-local-control',
        choices: [{ index: 0, message, finish_reason: 'stop' }],
      }),
    );
  });
});

server.listen(port, host, () => {
  console.log(`[stub-model] OpenAI 兼容替身已就绪：http://${host}:${port}/v1`);
  console.log(`[stub-model] 剧本命令：${command}`);
});
