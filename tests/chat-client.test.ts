import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { ConversationRefreshGuard, fetchChatJson } from '@/lib/chat-client';

describe('conversation polling races', () => {
  it('a delayed working poll cannot overwrite a completed message', async () => {
    const guard = new ConversationRefreshGuard();
    let displayed = 'working';
    let deliver!: () => void;
    const revision = guard.beginRead();
    const oldPoll = new Promise<void>((resolve) => {
      deliver = resolve;
    }).then(() => {
      if (guard.canApply(revision)) displayed = 'working';
    });
    const finish = guard.beginWrite();
    displayed = 'completed';
    finish();
    deliver();
    await oldPoll;
    assert.equal(displayed, 'completed');
    assert.equal(guard.canApply(guard.beginRead()), true);
  });

  it('polling while a save is in flight cannot erase the new optimistic message', () => {
    const guard = new ConversationRefreshGuard();
    const finish = guard.beginWrite();
    const revision = guard.beginRead();
    assert.equal(guard.canApply(revision), false);
    finish();
    assert.equal(guard.canApply(revision), false);
    assert.equal(guard.canApply(guard.beginRead()), true);
  });

  it('a server-completed shell/chat reply invalidates older polls without a browser save', () => {
    const guard = new ConversationRefreshGuard();
    const revision = guard.beginRead();
    guard.invalidate();
    assert.equal(guard.canApply(revision), false);
  });
});

describe('bounded chat HTTP waits', () => {
  let origin = '';
  const server = createServer((request, response) => {
    if (request.url === '/body-stalls') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"reply":');
      return;
    }
    if (request.url === '/headers-stall') return;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"reply":"已完成"}');
  });
  before(async () => {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it('ends waits when either headers or the JSON body stalls', async () => {
    for (const path of ['/headers-stall', '/body-stalls']) {
      await assert.rejects(
        fetchChatJson(origin + path, {}, 50),
        /等待响应超时/,
      );
    }
  });
  it('returns a completed reply without an artificial display delay', async () => {
    const { data } = await fetchChatJson<{ reply: string }>(
      origin + '/complete',
      {},
      2000,
    );
    assert.equal(data.reply, '已完成');
  });
  it('releases a stalled request when a saved reply arrives, without a false timeout', async () => {
    const controller = new AbortController();
    const request = fetchChatJson(
      origin + '/body-stalls',
      { signal: controller.signal },
      2000,
    );
    const rejected = assert.rejects(request, (error: Error) => {
      assert.equal(error.name, 'AbortError');
      assert.doesNotMatch(error.message, /等待响应超时/);
      return true;
    });
    controller.abort();
    await rejected;
  });
  it('does not start an already cancelled request', async () => {
    const controller = new AbortController();
    const reason = new Error('saved reply has already arrived');
    controller.abort(reason);
    await assert.rejects(
      fetchChatJson(origin + '/complete', { signal: controller.signal }, 2000),
      (error) => error === reason,
    );
  });
});
