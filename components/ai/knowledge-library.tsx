'use client';

import { useEffect, useId, useState } from 'react';
import { BookOpen, RefreshCw, X } from 'lucide-react';
import type { CourseStatus } from '@/lib/course-assistant-types';

/** Inventory only. Questions and model settings remain in the shared chat. */
export function KnowledgeLibrary({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const popoverId = useId();
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<CourseStatus | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetch('/api/course/status', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('暂时无法读取知识库，请稍后重试。');
        const data = (await response.json()) as CourseStatus;
        if (!Array.isArray(data.documents))
          throw new Error('暂时无法读取知识库，请稍后重试。');
        if (!controller.signal.aborted) setStatus(data);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : '暂时无法读取知识库，请稍后重试。',
          );
      });
    return () => controller.abort();
  }, [open, attempt]);

  return (
    <>
      <button
        type="button"
        className="consumer-shortcut"
        popoverTarget={popoverId}
        aria-label={collapsed ? '查看知识库' : undefined}
      >
        <BookOpen aria-hidden="true" />
        知识库
      </button>
      <div
        id={popoverId}
        popover="auto"
        className="ai-knowledge-library"
        onToggle={(event) => {
          const nextOpen = event.newState === 'open';
          if (nextOpen) {
            setStatus(null);
            setError('');
          }
          setOpen(nextOpen);
        }}
      >
        <header>
          <h2>课程知识库</h2>
          <button
            type="button"
            popoverTarget={popoverId}
            popoverTargetAction="hide"
            aria-label="关闭知识库"
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <p className="ai-knowledge-library-intro">
          直接在当前对话提问，AI 会按需要查阅以下课程资料。
        </p>
        <div aria-live="polite">
          {error ? (
            <div className="ai-knowledge-library-error">
              <p>{error}</p>
              <button
                type="button"
                onClick={() => {
                  setStatus(null);
                  setError('');
                  setAttempt((value) => value + 1);
                }}
              >
                <RefreshCw aria-hidden="true" />
                重新读取
              </button>
            </div>
          ) : status ? (
            <>
              <p className="ai-knowledge-library-status">
                {status.ready ? '可用于当前对话' : '知识库尚未就绪'} ·{' '}
                {status.document_count} 份文档 · {status.page_count} 页
              </p>
              {status.documents.length ? (
                <ul>
                  {status.documents.map((document, index) => (
                    <li key={`${document.name}-${index}`}>
                      <BookOpen aria-hidden="true" />
                      <span>{document.name}</span>
                      {document.pages ? (
                        <small>{document.pages} 页</small>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>暂时没有课程资料。</p>
              )}
            </>
          ) : (
            <p className="ai-knowledge-library-status">正在读取知识库…</p>
          )}
        </div>
      </div>
    </>
  );
}
