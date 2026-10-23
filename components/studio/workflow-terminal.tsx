'use client';

import { ArrowRight, Loader2, Play } from 'lucide-react';
import { useEffect, useRef, type RefObject } from 'react';
import type { WorkflowGraphV1 } from '@/lib/workflow-graph/types';
import { studioNodeRole } from '@/lib/workflow-graph/studio-input';

type TerminalEntry = {
  id: string;
  at: number;
  level: string;
  message: string;
};

export function WorkflowTerminal({
  graph,
  input,
  submittedInput,
  inputError,
  entries,
  response,
  error,
  running,
  inputRef,
  onInputChange,
  onSubmit,
}: {
  graph: WorkflowGraphV1;
  input: string;
  submittedInput: string | null;
  inputError: string | null;
  entries: TerminalEntry[];
  response: { data: unknown } | null;
  error?: string;
  running: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [entries, response, error, running]);

  const inputNodes = graph.nodes.filter((node) => node.type === 'trigger');
  const outputNodes = graph.nodes.filter((node) => node.type === 'output');
  const processingNodes = graph.nodes.filter(
    (node) => studioNodeRole(node.type) === '处理',
  );
  const output = response
    ? typeof response.data === 'string'
      ? response.data
      : JSON.stringify(response.data, null, 2)
    : '';

  return (
    <div className="studio-terminal">
      <div
        className="studio-terminal-interfaces"
        aria-label="工作流输入、处理、输出接口"
      >
        <span title={inputNodes.map((node) => node.name).join('、')}>
          <b>输入</b> {inputNodes.length || '未设置'}
        </span>
        <ArrowRight aria-hidden="true" />
        <span title={processingNodes.map((node) => node.name).join('、')}>
          <b>处理</b> {processingNodes.length}
        </span>
        <ArrowRight aria-hidden="true" />
        <span title={outputNodes.map((node) => node.name).join('、')}>
          <b>输出</b> {outputNodes.length || '未设置'}
        </span>
      </div>
      <div
        className="studio-terminal-log"
        ref={logRef}
        role="log"
        aria-label="终端运行记录"
        aria-relevant="additions text"
      >
        {submittedInput === null ? (
          <p className="studio-terminal-hint">
            输入文本或 JSON，按 Enter 运行；Shift + Enter 换行。
          </p>
        ) : (
          <pre className="studio-terminal-stdin">
            <span>stdin &gt; </span>
            {submittedInput}
          </pre>
        )}
        {entries.map((entry) => (
          <p
            className={`studio-terminal-entry level-${entry.level}`}
            key={entry.id}
          >
            <time>
              {new Date(entry.at).toLocaleTimeString('zh-CN', {
                hour12: false,
              })}
            </time>
            <span>{entry.message}</span>
          </p>
        ))}
        {response ? (
          <pre className="studio-terminal-stdout">
            <span>stdout</span>
            {'\n'}
            {output}
          </pre>
        ) : null}
        {error ? (
          <pre className="studio-terminal-stderr">
            <span>stderr</span>
            {'\n'}
            {error}
          </pre>
        ) : null}
        {running ? (
          <p className="studio-terminal-hint">正在处理，请稍候…</p>
        ) : submittedInput !== null && (response || error) ? (
          <p className={`studio-terminal-exit${error ? ' level-error' : ''}`}>
            进程结束 · exit {error ? 1 : 0}
          </p>
        ) : null}
      </div>
      <form
        className="studio-terminal-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label
          htmlFor="studio-terminal-input"
          className="studio-terminal-prompt"
        >
          stdin &gt;
        </label>
        <textarea
          ref={inputRef}
          id="studio-terminal-input"
          aria-label="终端输入"
          aria-describedby={
            inputError ? 'studio-terminal-input-error' : undefined
          }
          aria-invalid={Boolean(inputError)}
          value={input}
          rows={2}
          maxLength={16_000}
          placeholder="输入内容…"
          disabled={running}
          spellCheck={false}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        <button
          type="submit"
          disabled={running || !input.trim()}
          aria-label="提交终端输入并运行"
        >
          {running ? (
            <Loader2 className="studio-spin" aria-hidden="true" />
          ) : (
            <Play aria-hidden="true" />
          )}
          {running ? '运行中' : '运行'}
        </button>
      </form>
      {inputError ? (
        <p
          id="studio-terminal-input-error"
          className="studio-terminal-input-error"
          role="alert"
        >
          {inputError}
        </p>
      ) : null}
    </div>
  );
}
