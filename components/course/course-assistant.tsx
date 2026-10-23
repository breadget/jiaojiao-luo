'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent, SubmitEvent } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowUp,
  BookOpen,
  ChevronDown,
  FileText,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Workflow,
} from 'lucide-react';
import type { CourseAnswer, CourseStatus } from '@/lib/course-assistant-types';
import styles from './course-assistant.module.css';

const sampleQuestions = [
  '栈和队列有什么区别？',
  '队列入队和出队的时间复杂度是多少？',
  '顺序表和链表有什么区别？',
  'KMP 算法的 next 数组有什么作用？',
];

function documentNavigation(event: MouseEvent<HTMLAnchorElement>) {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  window.location.assign(event.currentTarget.href);
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : '暂时无法获取回答，请重试。';
}

async function apiJson<T>(response: Response): Promise<T> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error('课程助教暂时无法响应，请稍后重试。');
  }
  if (!response.ok) {
    if (data && typeof data === 'object' && 'error' in data) {
      const error = data.error;
      if (typeof error === 'string') throw new Error(error);
      if (error && typeof error === 'object' && 'message' in error) {
        if (typeof error.message === 'string') throw new Error(error.message);
      }
    }
    throw new Error('课程助教暂时无法响应，请稍后重试。');
  }
  return data as T;
}

function KnowledgeInventory({
  status,
  loading,
}: {
  status: CourseStatus | null;
  loading: boolean;
}) {
  if (!status)
    return (
      <p className={styles.inventoryHint}>
        {loading ? '正在读取课程文档…' : '暂时无法读取文档信息。'}
      </p>
    );
  return (
    <>
      <p className={styles.inventoryHint}>
        {status.document_count} 份文档 · {status.page_count} 页 ·{' '}
        {status.chunk_count} 个片段
      </p>
      {status.documents.length ? (
        <ul className={styles.fileList}>
          {status.documents.map((document) => (
            <li key={document.name}>
              <FileText aria-hidden="true" />
              <div>
                <span>{document.name}</span>
                {document.pages !== null ? (
                  <small>{document.pages} 页</small>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.inventoryHint}>知识库还没有课程文档。</p>
      )}
    </>
  );
}

export function CourseAssistant({
  embedded = false,
}: { embedded?: boolean } = {}) {
  const [status, setStatus] = useState<CourseStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<CourseAnswer | null>(null);
  const [submittedQuestion, setSubmittedQuestion] = useState('');
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const statusRequest = useRef<AbortController | null>(null);
  const answerRequest = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  const loadStatus = useCallback(async () => {
    statusRequest.current?.abort();
    const controller = new AbortController();
    statusRequest.current = controller;
    try {
      const response = await fetch('/api/course/status', {
        signal: controller.signal,
        cache: 'no-store',
      });
      const data = await apiJson<CourseStatus>(response);
      if (!controller.signal.aborted && mounted.current) setStatus(data);
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) {
        setStatusError(failureMessage(cause));
      }
    } finally {
      if (!controller.signal.aborted && mounted.current)
        setStatusLoading(false);
      if (statusRequest.current === controller) statusRequest.current = null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const connect = window.setTimeout(() => void loadStatus(), 0);
    return () => {
      mounted.current = false;
      window.clearTimeout(connect);
      statusRequest.current?.abort();
      answerRequest.current?.abort();
    };
  }, [loadStatus]);

  useEffect(() => {
    if (submittedQuestion) streamRef.current?.scrollTo({ top: 0 });
  }, [submittedQuestion]);

  async function ask(value: string) {
    const nextQuestion = value.trim();
    if (!nextQuestion || nextQuestion.length > 2000 || answerRequest.current)
      return;
    const controller = new AbortController();
    answerRequest.current = controller;
    setBusy(true);
    setAnswer(null);
    setAnswerError(null);
    setSubmittedQuestion(nextQuestion);
    try {
      const response = await fetch('/api/course/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: nextQuestion }),
        signal: controller.signal,
      });
      const data = await apiJson<CourseAnswer>(response);
      if (!controller.signal.aborted && mounted.current) {
        setAnswer(data);
        setQuestion('');
      }
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) {
        setAnswerError(failureMessage(cause));
      }
    } finally {
      if (!controller.signal.aborted && mounted.current) setBusy(false);
      if (answerRequest.current === controller) answerRequest.current = null;
    }
  }

  function refreshStatus() {
    setStatusLoading(true);
    setStatusError(null);
    void loadStatus();
  }

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(question);
  }

  function clearQuestion() {
    if (busy) return;
    setQuestion('');
    setAnswer(null);
    setAnswerError(null);
    setSubmittedQuestion('');
    inputRef.current?.focus();
  }

  const knowledgeUnavailable = status !== null && !status.ready;
  const canAsk = Boolean(question.trim()) && !busy && !knowledgeUnavailable;
  const modeMessage = statusLoading
    ? '正在连接知识库'
    : statusError
      ? '知识库连接暂不可用'
      : knowledgeUnavailable
        ? status?.stale
          ? '课程文档已更新，等待重建知识库'
          : '知识库尚未就绪'
        : status?.llm_configured
          ? '根据原文生成回答'
          : '当前仅检索原文';

  const WorkspaceRegion = embedded ? 'section' : 'main';
  const Heading = embedded ? 'h2' : 'h1';

  return (
    <div
      className={`${styles.workspace}${embedded ? ` ${styles.embedded}` : ''}`}
    >
      <aside className={styles.sidebar} aria-label="课程助教导航">
        {embedded ? null : (
          <div className={styles.brandRow}>
            <Link
              className={styles.brand}
              href="/"
              prefetch={false}
              onClick={documentNavigation}
              aria-label="Urtoris 工作台入口"
            >
              <span className={styles.brandMark}>
                <Workflow aria-hidden="true" />
              </span>
              <strong>Urtoris</strong>
            </Link>
            <Link
              className={styles.mobileBack}
              href="/"
              prefetch={false}
              onClick={documentNavigation}
              aria-label="返回工作台"
            >
              <ArrowLeft aria-hidden="true" />
            </Link>
          </div>
        )}
        <nav className={styles.navigation} aria-label="工作台导航">
          {embedded ? null : (
            <>
              <Link
                className={styles.returnLink}
                href="/"
                prefetch={false}
                onClick={documentNavigation}
              >
                <ArrowLeft aria-hidden="true" />
                返回工作台
              </Link>
              <Link
                className={styles.activeLink}
                href="/course"
                prefetch={false}
                onClick={documentNavigation}
                aria-current="page"
              >
                <BookOpen aria-hidden="true" />
                课程助教
              </Link>
            </>
          )}
          <button type="button" onClick={clearQuestion} disabled={busy}>
            <MessageSquarePlus aria-hidden="true" />
            新问题
          </button>
        </nav>
        <section
          className={styles.knowledgePanel}
          aria-labelledby="knowledge-title"
        >
          <h2 id="knowledge-title">课程知识库</h2>
          <KnowledgeInventory status={status} loading={statusLoading} />
        </section>
        <div className={styles.sidebarFoot}>
          <span className={styles.serviceStatus}>
            {statusLoading ? (
              <Loader2 className={styles.spinner} aria-hidden="true" />
            ) : (
              <Search aria-hidden="true" />
            )}
            {modeMessage}
          </span>
          {!statusLoading && (statusError || knowledgeUnavailable) ? (
            <button
              className={styles.retryStatus}
              type="button"
              onClick={refreshStatus}
            >
              <RefreshCw aria-hidden="true" />
              重新连接
            </button>
          ) : null}
          {status && !status.llm_configured ? (
            <p>模型启用后，可根据这些原文生成回答。</p>
          ) : null}
        </div>
      </aside>

      <WorkspaceRegion className={styles.main}>
        <header className={styles.header}>
          <Heading>{embedded ? '课程知识问答' : '课程助教'}</Heading>
          <span className={styles.headerDescription}>数据结构与算法</span>
          <details className={styles.mobileKnowledge}>
            <summary>
              <FileText aria-hidden="true" />
              <span>知识库</span>
              <ChevronDown aria-hidden="true" />
            </summary>
            <div className={styles.mobileInventory}>
              <KnowledgeInventory status={status} loading={statusLoading} />
            </div>
          </details>
        </header>

        <div className={styles.stream} ref={streamRef}>
          {statusError || knowledgeUnavailable ? (
            <output className={styles.connectionNotice}>
              <span>{statusError ?? modeMessage}</span>
              <button
                type="button"
                disabled={statusLoading}
                onClick={refreshStatus}
              >
                <RefreshCw aria-hidden="true" />
                {statusLoading ? '正在连接…' : '重新连接'}
              </button>
            </output>
          ) : null}

          {!submittedQuestion ? (
            <section className={styles.empty} aria-labelledby="course-prompt">
              <BookOpen className={styles.promptIcon} aria-hidden="true" />
              <h2 id="course-prompt">这次想弄懂什么？</h2>
              <p>从课程文档中寻找答案，附上可核对的原文。</p>
              <div className={styles.samples} aria-label="示例问题">
                {sampleQuestions.map((sample) => (
                  <button
                    key={sample}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setQuestion(sample);
                      inputRef.current?.focus();
                    }}
                  >
                    {sample}
                    <ArrowUp aria-hidden="true" />
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <section className={styles.exchange} aria-label="课程问答">
              <div className={styles.userQuestion}>
                <p>{submittedQuestion}</p>
              </div>
              <div className={styles.answerRow}>
                <span className={styles.answerAvatar}>
                  <BookOpen aria-hidden="true" />
                </span>
                <div className={styles.answerContent}>
                  <p className={styles.answerAuthor}>
                    {embedded ? 'AI 智能体' : '课程助教'}
                  </p>
                  {busy ? (
                    <output className={styles.working}>
                      <Loader2 className={styles.spinner} aria-hidden="true" />
                      正在检索课程文档…
                    </output>
                  ) : null}
                  {answerError ? (
                    <div className={styles.error} role="alert">
                      <p>{answerError}</p>
                      <button
                        type="button"
                        onClick={() => void ask(submittedQuestion)}
                      >
                        <RefreshCw aria-hidden="true" />
                        重试这个问题
                      </button>
                    </div>
                  ) : null}
                  {answer ? (
                    <>
                      {answer.mode === 'retrieval_only' ||
                      answer.mode === 'no_match' ? (
                        <p className={styles.answerMode}>
                          <Search aria-hidden="true" />
                          {answer.mode === 'retrieval_only'
                            ? '仅检索原文'
                            : '未找到匹配内容'}
                        </p>
                      ) : null}
                      <div className={styles.answerText}>{answer.answer}</div>
                      {answer.warning ? (
                        <p className={styles.warning}>{answer.warning}</p>
                      ) : null}
                      {answer.sources.length ? (
                        <section
                          className={styles.sources}
                          aria-labelledby="course-sources"
                        >
                          <h2 id="course-sources">
                            原文依据 <span>{answer.sources.length}</span>
                          </h2>
                          {answer.sources.map((source, index) => (
                            <details key={source.id} className={styles.source}>
                              <summary>
                                <span className={styles.sourceNumber}>
                                  {index + 1}
                                </span>
                                <span className={styles.sourceFilename}>
                                  {source.filename}
                                </span>
                                <span className={styles.sourcePage}>
                                  第 {source.page} 页
                                </span>
                                <ChevronDown
                                  className={styles.sourceChevron}
                                  aria-hidden="true"
                                />
                              </summary>
                              <blockquote>{source.excerpt}</blockquote>
                            </details>
                          ))}
                        </section>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
            </section>
          )}
        </div>

        <div className={styles.composerArea}>
          <form
            className={styles.composer}
            onSubmit={submit}
            aria-label="向课程助教提问"
          >
            <label htmlFor="course-question" className={styles.srOnly}>
              输入课程问题
            </label>
            <textarea
              id="course-question"
              ref={inputRef}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="问一个关于数据结构与算法的问题…"
              maxLength={2000}
              rows={2}
              disabled={busy}
              aria-describedby="course-composer-hint"
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  if (canAsk) void ask(question);
                }
              }}
            />
            <div className={styles.composerBottom}>
              <span>
                <BookOpen aria-hidden="true" />
                课程知识库
              </span>
              <div className={styles.composerAction}>
                {question.length > 1800 ? (
                  <span className={styles.characterCount}>
                    {question.length} / 2000
                  </span>
                ) : null}
                <button
                  className={styles.send}
                  type="submit"
                  disabled={!canAsk}
                  aria-label={busy ? '正在获取回答' : '发送问题'}
                >
                  {busy ? (
                    <Loader2 className={styles.spinner} aria-hidden="true" />
                  ) : (
                    <ArrowUp aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
          </form>
          <p className={styles.composerHint} id="course-composer-hint">
            {status?.ready && !status.llm_configured && !busy ? (
              <span className={styles.mobileMode}>当前仅检索原文 · </span>
            ) : null}
            {busy
              ? '正在获取回答，请稍候。'
              : 'Enter 发送 · Shift + Enter 换行。请结合原文核对回答。'}
          </p>
        </div>
        <output className={styles.srOnly} aria-live="polite">
          {busy
            ? '正在获取回答'
            : answer
              ? answer.mode === 'retrieval_only'
                ? '检索已完成，原文依据可展开阅读。'
                : answer.mode === 'no_match'
                  ? '检索已完成，未找到相关原文。'
                  : '回答已完成，原文依据可展开阅读。'
              : ''}
        </output>
      </WorkspaceRegion>
    </div>
  );
}
