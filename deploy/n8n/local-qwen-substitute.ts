/** Local OpenAI-compatible substitute; test credentials only, no remote calls. */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
if (process.env.URTORIS_CLONE_CANARY !== '1' || !root)
  throw new Error('CLONE_MARKER_REQUIRED');
if (
  JSON.parse(readFileSync(join(root, 'graph-runtime-clone.json'), 'utf8'))
    .marker !== 'isolated-urtoris-graph-canary'
)
  throw new Error('INVALID_CLONE_MARKER');
const secrets = JSON.parse(
  readFileSync(join(root, 'test-secrets.json'), 'utf8'),
) as { model: string };
type Message = { role: string; content: string };
const requests: Array<{ mode: string; messages: Message[] }> = [];
let mode = 'success';
const server = createServer(async (req, res) => {
  const rejection = req.url?.match(
    /^\/canary\/binding-reject\/(400|401|404|409|503)$/,
  );
  if (rejection) {
    res
      .writeHead(Number(rejection[1]), { 'Content-Type': 'application/json' })
      .end('{"ok":true,"bound":true}');
    return;
  }
  if (req.url === '/canary/control' && req.method === 'POST') {
    let body = '';
    for await (const part of req) body += part;
    const next = JSON.parse(body) as { mode: string };
    if (!['success', 'wrong-key', 'malformed', 'network'].includes(next.mode)) {
      res.writeHead(400).end();
      return;
    }
    mode = next.mode;
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end('{"ok":true}');
    return;
  }
  if (req.url === '/canary/requests') {
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(requests));
    return;
  }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  let text = '';
  for await (const part of req) text += part;
  const body = JSON.parse(text) as { messages: Message[] };
  requests.push({ mode, messages: body.messages });
  // Only synthetic prompts are used; this file stays in the ignored clone directory.
  writeFileSync(
    join(root, 'substitute-requests.json'),
    JSON.stringify(requests, null, 2),
  );
  if (mode === 'network') {
    req.socket.destroy();
    return;
  }
  if (
    mode === 'wrong-key' ||
    req.headers.authorization !== `Bearer ${secrets.model}`
  ) {
    res
      .writeHead(401, { 'Content-Type': 'application/json' })
      .end(
        JSON.stringify({
          error: {
            message: 'Invalid test credential',
            type: 'invalid_api_key',
          },
        }),
      );
    return;
  }
  if (mode === 'malformed') {
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end('{broken-json');
    return;
  }
  const content = JSON.stringify({
    answer: 'Local Qwen substitute response',
    previousUserMessages: body.messages.filter((m) => m.role === 'user').length,
  });
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(
    JSON.stringify({
      id: 'canary-local-completion',
      object: 'chat.completion',
      created: 1,
      model: 'qwen-canary-local',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
});
server.listen(5690, '127.0.0.1', () =>
  console.log('Local substitute listening on 127.0.0.1:5690'),
);
