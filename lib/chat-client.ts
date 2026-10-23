/** Do not apply a poll captured before or during a local message write. */
export class ConversationRefreshGuard {
  private revision = 0;
  private writes = 0;

  beginRead(): number {
    return this.revision;
  }

  canApply(revision: number): boolean {
    return this.writes === 0 && this.revision === revision;
  }

  invalidate(): void {
    this.revision++;
  }

  beginWrite(): () => void {
    this.writes++;
    this.invalidate();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.writes--;
      this.invalidate();
    };
  }
}

/** Bound both waiting for headers and reading the response body. */
export async function fetchChatJson<T>(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; data: T }> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) cancel();
  else init.signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const data = (await response.json()) as T;
    return { response, data };
  } catch (cause) {
    if (timedOut) {
      throw new Error(
        '等待响应超时，正在恢复已保存的结果。请勿重复发送同一条消息。',
      );
    }
    throw cause;
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', cancel);
  }
}
