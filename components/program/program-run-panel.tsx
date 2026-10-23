'use client';

import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import {
  CheckCircle2,
  CircleDashed,
  Clock3,
  Download,
  Loader2,
  Play,
  RefreshCw,
  Square,
  XCircle,
} from 'lucide-react';
import { KnowledgeSources } from '@/components/ai/knowledge-sources';
import { randomId } from '@/lib/random-id';
import type { LlmConfig } from '@/lib/workflow-types';
import type {
  ProgramDescription,
  ProgramJob,
  ProgramNodeSnapshot,
} from '@/lib/workflow-program/types';
import {
  fetchProgramJson,
  programDefaults,
  programIsLive,
  programStartPayload,
  programStatusLabels,
  type ProgramFormValues,
} from './program-client';
import styles from './program.module.css';

const nodeLabels: Record<ProgramNodeSnapshot['state'], string> = {
  waiting: '等待',
  running: '执行中',
  success: '完成',
  error: '失败',
  skipped: '已跳过',
};

function NodeState({ state }: { state: ProgramNodeSnapshot['state'] }) {
  if (state === 'running')
    return <Loader2 className="spin" aria-hidden="true" />;
  if (state === 'success') return <CheckCircle2 aria-hidden="true" />;
  if (state === 'error') return <XCircle aria-hidden="true" />;
  if (state === 'waiting') return <Clock3 aria-hidden="true" />;
  return <CircleDashed aria-hidden="true" />;
}

export function ProgramRunPanel({
  workflowId,
  llm,
  llmConfigured,
  consumerSessionId,
  focusJobId,
  onSettings,
  onJobChange,
}: {
  workflowId: string;
  llm: LlmConfig;
  llmConfigured: boolean;
  consumerSessionId?: string | null;
  focusJobId?: string | null;
  onSettings: () => void;
  onJobChange?: (job: ProgramJob) => void;
}) {
  const [program, setProgram] = useState<ProgramDescription | null>(null);
  const [values, setValues] = useState<ProgramFormValues>({});
  const [job, setJob] = useState<ProgramJob | null>(null);
  const [jobHistory, setJobHistory] = useState<ProgramJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'start' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [pollRevision, setPollRevision] = useState(0);
  const mutationLock = useRef(false);
  const scopeRevision = useRef(0);
  const pendingRequest = useRef<{ signature: string; id: string } | null>(null);
  const changeRef = useRef(onJobChange);
  useEffect(() => {
    changeRef.current = onJobChange;
  }, [onJobChange]);
  const active = programIsLive(job);
  const jobId = job?.id;

  useEffect(() => {
    const controller = new AbortController();
    scopeRevision.current += 1;
    mutationLock.current = false;
    let current = true;
    queueMicrotask(() => {
      if (!current) return;
      setLoading(true);
      setBusy(null);
      setError(null);
      setProgram(null);
      setJob(null);
      setJobHistory([]);
      pendingRequest.current = null;
      setPollError(null);
    });
    void (async () => {
      try {
        const description = await fetchProgramJson<{
          program: ProgramDescription | null;
        }>(`/api/programs?workflowId=${encodeURIComponent(workflowId)}`, {
          signal: controller.signal,
        });
        if (!current) return;
        if (!description.program)
          throw new Error(
            '这个工作流还没有可运行的发布版本。请在创建端发布程序后重试。',
          );
        setProgram(description.program);
        setValues(programDefaults(description.program.inputFields));
        const history = await fetchProgramJson<{ jobs: ProgramJob[] }>(
          `/api/programs/runs?workflowId=${encodeURIComponent(workflowId)}${consumerSessionId ? `&consumerSessionId=${encodeURIComponent(consumerSessionId)}` : ''}`,
          { signal: controller.signal },
        );
        if (!current) return;
        setJobHistory(history.jobs);
        const recovery = focusJobId
          ? await fetchProgramJson<{ job: ProgramJob }>(
              `/api/programs/runs/${encodeURIComponent(focusJobId)}`,
              { signal: controller.signal },
            ).then((data) => data.job)
          : ([...history.jobs].sort((a, b) => b.createdAt - a.createdAt)[0] ??
            null);
        if (!current || (recovery && recovery.workflowId !== workflowId))
          return;
        if (recovery) {
          setJob(recovery);
          changeRef.current?.(recovery);
          setValues({
            ...programDefaults(description.program.inputFields),
            ...Object.fromEntries(
              description.program.inputFields
                .filter((field) => recovery.input[field.name] !== undefined)
                .map((field) => [
                  field.name,
                  field.type === 'boolean'
                    ? recovery.input[field.name] === true
                    : String(recovery.input[field.name]),
                ]),
            ),
          });
        }
      } catch (cause) {
        if (current && !controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '读取程序失败。');
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
      controller.abort();
    };
  }, [workflowId, consumerSessionId, focusJobId, reload]);

  useEffect(() => {
    if (!jobId || !active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await fetchProgramJson<{ job: ProgramJob }>(
          `/api/programs/runs/${encodeURIComponent(jobId)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setJob(data.job);
        setJobHistory((history) => [
          data.job,
          ...history.filter((item) => item.id !== data.job.id),
        ]);
        changeRef.current?.(data.job);
        setPollError(null);
        if (programIsLive(data.job)) timer = setTimeout(poll, 1500);
      } catch (cause) {
        if (!controller.signal.aborted)
          setPollError(
            cause instanceof Error ? cause.message : '状态刷新中断。',
          );
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [jobId, active, pollRevision]);

  async function start(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!program || mutationLock.current || active) return;
    const scope = scopeRevision.current;
    mutationLock.current = true;
    setBusy('start');
    setError(null);
    try {
      const signature = JSON.stringify({
        versionId: program.versionId,
        values,
      });
      if (pendingRequest.current?.signature !== signature)
        pendingRequest.current = { signature, id: randomId() };
      const payload = programStartPayload(
        program,
        values,
        llm,
        pendingRequest.current.id,
        consumerSessionId,
      );
      const data = await fetchProgramJson<{ job: ProgramJob }>(
        '/api/programs/runs',
        { method: 'POST', body: JSON.stringify(payload) },
      );
      if (scope !== scopeRevision.current) return;
      setJob(data.job);
      setJobHistory((history) => [
        data.job,
        ...history.filter((item) => item.id !== data.job.id),
      ]);
      changeRef.current?.(data.job);
      setPollError(null);
      pendingRequest.current = null;
    } catch (cause) {
      if (scope === scopeRevision.current)
        setError(cause instanceof Error ? cause.message : '启动失败，请重试。');
    } finally {
      if (scope === scopeRevision.current) {
        mutationLock.current = false;
        setBusy(null);
      }
    }
  }

  async function cancel() {
    if (!job || mutationLock.current || !active) return;
    const scope = scopeRevision.current;
    mutationLock.current = true;
    setBusy('cancel');
    setError(null);
    try {
      const data = await fetchProgramJson<{ job: ProgramJob }>(
        `/api/programs/runs/${encodeURIComponent(job.id)}`,
        { method: 'DELETE' },
      );
      if (scope !== scopeRevision.current) return;
      setJob(data.job);
      setJobHistory((history) => [
        data.job,
        ...history.filter((item) => item.id !== data.job.id),
      ]);
      changeRef.current?.(data.job);
    } catch (cause) {
      if (scope === scopeRevision.current)
        setError(cause instanceof Error ? cause.message : '取消失败，请重试。');
    } finally {
      if (scope === scopeRevision.current) {
        mutationLock.current = false;
        setBusy(null);
      }
    }
  }

  if (loading)
    return (
      <output className={styles.loading}>
        <span />
        读取已发布程序…
      </output>
    );
  if (!program)
    return (
      <div className={styles.panel}>
        <p role="alert">{error}</p>
        <button
          className={styles.secondary}
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCw aria-hidden="true" />
          重新读取
        </button>
      </div>
    );

  const snapshots = job
    ? Object.values(job.nodes).sort(
        (a, b) =>
          (a.startedAt ?? Number.MAX_SAFE_INTEGER) -
          (b.startedAt ?? Number.MAX_SAFE_INTEGER),
      )
    : [];
  return (
    <div className={styles.panel}>
      <div className={styles.programHeading}>
        <strong>{program.name}</strong>
        <span>已发布 v{program.workflowVersion}</span>
      </div>
      <form onSubmit={(event) => void start(event)} className={styles.form}>
        <fieldset disabled={active || busy !== null}>
          <legend>运行输入</legend>
          {program.inputFields.length ? (
            program.inputFields.map((field) => (
              <label
                key={field.name}
                className={
                  field.type === 'boolean' ? styles.checkbox : styles.field
                }
              >
                <span>
                  {field.label}
                  {field.required ? (
                    <span className={styles.required}>必填</span>
                  ) : null}
                </span>
                {field.type === 'boolean' ? (
                  <input
                    type="checkbox"
                    checked={values[field.name] === true}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [field.name]: event.target.checked,
                      }))
                    }
                  />
                ) : field.type === 'number' ? (
                  <input
                    type="number"
                    value={String(values[field.name] ?? '')}
                    min={field.min}
                    max={field.max}
                    step="any"
                    required={field.required}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [field.name]: event.target.value,
                      }))
                    }
                  />
                ) : (
                  <textarea
                    rows={2}
                    minLength={field.min}
                    maxLength={Math.min(field.max ?? 16000, 16000)}
                    value={String(values[field.name] ?? '')}
                    required={field.required}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [field.name]: event.target.value,
                      }))
                    }
                  />
                )}
              </label>
            ))
          ) : (
            <p className={styles.muted}>这个程序无需填写参数，可直接运行。</p>
          )}
        </fieldset>
        {program.requiresModel ? (
          <p className={styles.model}>
            使用统一模型：{llmConfigured ? llm.model : '尚未配置'}
            <button type="button" onClick={onSettings}>
              打开设置
            </button>
          </p>
        ) : (
          <p className={styles.muted}>这个程序无需模型密钥。</p>
        )}
        <div className={styles.actions}>
          <button
            type="submit"
            className={styles.primary}
            disabled={
              active ||
              busy !== null ||
              (program.requiresModel && !llmConfigured)
            }
          >
            {busy === 'start' ? (
              <Loader2 className="spin" aria-hidden="true" />
            ) : (
              <Play aria-hidden="true" />
            )}
            {busy === 'start'
              ? '正在启动'
              : active
                ? '程序运行中'
                : job
                  ? '再次运行'
                  : '运行程序'}
          </button>
          {active ? (
            <button
              type="button"
              className={styles.secondary}
              disabled={busy !== null}
              onClick={() => void cancel()}
            >
              <Square aria-hidden="true" />
              {busy === 'cancel' ? '正在取消' : '取消运行'}
            </button>
          ) : null}
        </div>
      </form>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {pollError ? (
        <div className={styles.error} role="alert">
          <p>{pollError} 运行可能仍在继续。</p>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => {
              setPollError(null);
              setPollRevision((value) => value + 1);
            }}
          >
            <RefreshCw aria-hidden="true" />
            重新获取状态
          </button>
        </div>
      ) : null}
      {jobHistory.length > 1 ? (
        <label className={styles.field}>
          <span>运行历史</span>
          <select
            value={job?.id ?? ''}
            disabled={busy !== null || active}
            onChange={(event) => {
              const selected = jobHistory.find(
                (item) => item.id === event.target.value,
              );
              if (selected) {
                setJob(selected);
                changeRef.current?.(selected);
                setPollError(null);
              }
            }}
          >
            {jobHistory.map((item) => (
              <option key={item.id} value={item.id}>
                {new Date(item.createdAt).toLocaleString('zh-CN')} · v
                {item.workflowVersion} · {programStatusLabels[item.status]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {job ? (
        <section className={styles.execution} aria-label="本次程序运行">
          <div className={styles.sectionHeading}>
            <h3>{programStatusLabels[job.status]}</h3>
            <span>
              v{job.workflowVersion} ·{' '}
              {new Date(job.createdAt).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
          <p className={styles.muted}>
            {job.status === 'queued'
              ? '任务已提交，等待执行。'
              : job.status === 'running'
                ? '关闭详情或刷新页面后，任务仍会在后台继续。'
                : job.status === 'cancelled'
                  ? '运行已取消。你可以调整输入后再次运行。'
                  : job.status === 'failed'
                    ? (job.error?.message ?? '运行失败，请检查输入后重试。')
                    : '结果已生成，可以阅读或下载文件。'}
          </p>
          <ol className={styles.nodes} aria-label="节点执行状态">
            {snapshots.map((node) => (
              <li key={node.id} data-state={node.state}>
                <NodeState state={node.state} />
                <div>
                  <span>{node.name}</span>
                  {node.error ? <p>{node.error}</p> : null}
                  {node.input !== undefined || node.output !== undefined ? (
                    <details className={styles.nodeData}>
                      <summary>查看输入和输出</summary>
                      {node.input !== undefined ? (
                        <div>
                          <h4>输入</h4>
                          <pre>{JSON.stringify(node.input, null, 2)}</pre>
                        </div>
                      ) : null}
                      {node.output !== undefined ? (
                        <div>
                          <h4>输出</h4>
                          <pre>{JSON.stringify(node.output, null, 2)}</pre>
                        </div>
                      ) : null}
                    </details>
                  ) : null}
                </div>
                <small>{nodeLabels[node.state]}</small>
              </li>
            ))}
          </ol>
          {job.status === 'completed' && job.result ? (
            <div className={styles.result}>
              <h3>运行结果</h3>
              {job.result.model ? (
                <p className={styles.muted}>
                  生成模型：{job.result.model.model}
                </p>
              ) : null}
              {job.artifacts.length ? (
                <ul className={styles.files} aria-label="结果文件">
                  {job.artifacts.map((artifact) => (
                    <li key={artifact.id}>
                      <a
                        href={`/api/programs/runs/${encodeURIComponent(job.id)}/artifacts/${encodeURIComponent(artifact.id)}`}
                        download={artifact.name}
                      >
                        <Download aria-hidden="true" />
                        <span>
                          {artifact.name}
                          <small>
                            {artifact.sizeBytes < 1024
                              ? `${artifact.sizeBytes} B`
                              : `${(artifact.sizeBytes / 1024).toFixed(1)} KB`}
                          </small>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.muted}>本次运行没有生成文件。</p>
              )}
              {job.result.text ? (
                <textarea
                  className={styles.resultText}
                  readOnly
                  rows={12}
                  aria-label="结果预览"
                  value={job.result.text}
                />
              ) : (
                <p className={styles.muted}>程序已完成，没有返回文字。</p>
              )}
              {job.result.sources.length ? (
                <KnowledgeSources
                  knowledge={{
                    mode: job.result.model ? 'llm' : 'retrieval_only',
                    sources: job.result.sources,
                  }}
                />
              ) : null}
            </div>
          ) : null}
        </section>
      ) : (
        <p className={styles.empty}>
          填写参数并运行。真实节点状态、结果和文件会显示在这里。
        </p>
      )}
    </div>
  );
}
