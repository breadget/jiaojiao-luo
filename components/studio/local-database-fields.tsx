'use client';

import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { CheckCircle2, FolderOpen, Loader2, PlugZap } from 'lucide-react';
import {
  checkDatabaseAssistant,
  getDatabaseConnectionCode,
  subscribeDatabaseConnection,
  inspectLocalDatabase,
  pickLocalDatabase,
  setDatabaseConnectionCode,
} from '@/lib/local-database-client';
import type { LocalDatabaseSchema } from '@/lib/local-database-protocol';

export function LocalDatabaseConnector() {
  const id = useId();
  const code = useSyncExternalStore(
    subscribeDatabaseConnection,
    getDatabaseConnectionCode,
    () => '',
  );
  const [inputCode, setInputCode] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<{
    code: string;
    state: 'connected' | 'error';
    message: string;
  } | null>(null);
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    void checkDatabaseAssistant()
      .then(() => {
        if (!cancelled)
          setConnection({
            code,
            state: 'connected',
            message: '已连接这台电脑 · 只读 SQLite',
          });
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setConnection({
            code,
            state: 'error',
            message:
              cause instanceof Error ? cause.message : '连接助手不可用。',
          });
      });
    return () => {
      cancelled = true;
    };
  }, [code, attempt]);
  const state = !code
    ? 'idle'
    : connection?.code === code
      ? connection.state
      : 'checking';
  const message = !code
    ? '本机数据库助手未连接'
    : connection?.code === code
      ? connection.message
      : '正在连接这台电脑…';
  return (
    <div className="local-database-connector">
      <output className="local-database-status" data-state={state}>
        {state === 'connected' ? (
          <CheckCircle2 aria-hidden="true" />
        ) : (
          <PlugZap aria-hidden="true" />
        )}
        {message}
      </output>
      {state !== 'connected' ? (
        <>
          <p className="local-database-help">
            在电脑上运行 <code>npm run database:local</code>
            ，打开助手的连接页面，再点击“打开工作台并连接”。
          </p>
          <div className="local-database-actions">
            <a
              href="http://127.0.0.1:3022/connect"
              target="_blank"
              rel="noreferrer"
            >
              打开本机助手
            </a>
            {code && state === 'error' ? (
              <button
                type="button"
                onClick={() => {
                  setConnection(null);
                  setAttempt((current) => current + 1);
                }}
              >
                重试连接
              </button>
            ) : null}
          </div>
          <details className="local-database-manual">
            <summary>手动填写连接代码</summary>
            <label htmlFor={id}>连接代码</label>
            <input
              id={id}
              type="password"
              value={inputCode}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setInputCode(event.target.value)}
            />
            <button
              type="button"
              disabled={
                !/^[a-f0-9]{64}$/.test(inputCode.trim()) || state === 'checking'
              }
              onClick={() => {
                setConnection(null);
                setAttempt((current) => current + 1);
                setDatabaseConnectionCode(inputCode);
              }}
            >
              连接这台电脑
            </button>
          </details>
        </>
      ) : (
        <div className="local-database-actions">
          <button
            type="button"
            onClick={() => {
              setDatabaseConnectionCode('');
              setInputCode('');
            }}
          >
            断开本机连接
          </button>
        </div>
      )}
    </div>
  );
}

export function LocalDatabaseFields({
  config,
  onChange,
  connectedToAgent,
  onConnectAgent,
}: {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  connectedToAgent: boolean;
  onConnectAgent?: () => void;
}) {
  const id = useId();
  const filePath = typeof config.filePath === 'string' ? config.filePath : '';
  const [tested, setTested] = useState<{
    filePath: string;
    schema: LocalDatabaseSchema;
  } | null>(null);
  const [busy, setBusy] = useState<'pick' | 'test' | null>(null);
  const [failure, setFailure] = useState<{
    filePath: string;
    message: string;
  } | null>(null);
  const schema = tested?.filePath === filePath ? tested.schema : null;
  const error = failure?.filePath === filePath ? failure.message : '';
  const test = async () => {
    setBusy('test');
    setFailure(null);
    setTested(null);
    try {
      setTested({
        filePath,
        schema: await inspectLocalDatabase(filePath.trim()),
      });
    } catch (cause) {
      setFailure({
        filePath,
        message: cause instanceof Error ? cause.message : '数据库连接失败。',
      });
    } finally {
      setBusy(null);
    }
  };
  const pick = async () => {
    setBusy('pick');
    setFailure(null);
    try {
      const selected = await pickLocalDatabase();
      if (selected.filePath)
        onChange({
          ...config,
          provider: 'sqlite',
          location: 'local',
          operation: 'select',
          filePath: selected.filePath,
        });
    } catch (cause) {
      setFailure({
        filePath,
        message: cause instanceof Error ? cause.message : '无法选择文件。',
      });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="studio-local-database">
      <LocalDatabaseConnector />
      <label htmlFor={id}>
        <span>数据库文件位置</span>
        <input
          id={id}
          value={filePath}
          disabled={busy !== null}
          placeholder="/Users/你的用户名/Documents/orders.sqlite"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-help`}
          onChange={(event) =>
            onChange({
              ...config,
              provider: 'sqlite',
              location: 'local',
              operation: 'select',
              filePath: event.target.value,
            })
          }
        />
      </label>
      <p id={`${id}-help`} className="local-database-help">
        填写电脑上的绝对路径，支持
        .db、.sqlite、.sqlite3。文件保留在电脑上，查询结果会发给你选择的 AI
        模型。
      </p>
      <div className="local-database-actions">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void pick()}
        >
          <FolderOpen aria-hidden="true" />
          {busy === 'pick' ? '正在选择…' : '选择文件'}
        </button>
        <button
          type="button"
          disabled={!filePath.trim() || busy !== null}
          onClick={() => void test()}
        >
          {busy === 'test' ? (
            <Loader2 className="studio-spin" aria-hidden="true" />
          ) : (
            <PlugZap aria-hidden="true" />
          )}
          {busy === 'test' ? '正在测试…' : '测试连接'}
        </button>
      </div>
      {error ? (
        <p className="local-database-error" role="alert">
          {error}
        </p>
      ) : null}
      {schema ? (
        <div className="local-database-schema">
          <output>
            <CheckCircle2 aria-hidden="true" />
            连接成功 · {schema.tables.length} 张表 / 视图
            {schema.truncated ? '（部分显示）' : ''}
          </output>
          {schema.tables.length ? (
            <details>
              <summary>查看表结构</summary>
              <ul>
                {schema.tables.map((table) => (
                  <li key={table.name}>
                    <strong>{table.name}</strong>
                    <span>
                      {table.columns
                        .map(
                          (column) =>
                            `${column.name}${column.type ? ` ${column.type}` : ''}`,
                        )
                        .join(' · ')}
                      {table.truncated ? ' …' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <p>这个数据库还没有可查询的表。</p>
          )}
        </div>
      ) : null}
      <label>
        <span>每次查询最多返回行数</span>
        <input
          type="number"
          min={1}
          max={500}
          step={1}
          value={Number(config.maxRows) || 100}
          onChange={(event) =>
            onChange({ ...config, maxRows: Number(event.target.value) })
          }
        />
      </label>
      <p className="local-database-help">
        AI
        先读取表结构，再按需要查询。此连接只允许读取，不能新增、修改或删除数据。
      </p>
      {connectedToAgent ? (
        <p className="local-database-status" data-state="connected">
          <CheckCircle2 aria-hidden="true" />
          已连接 AI Agent 的工具接口
        </p>
      ) : (
        <div className="local-database-actions">
          <button
            type="button"
            disabled={!onConnectAgent}
            onClick={onConnectAgent}
          >
            连接到 AI Agent
          </button>
          <p className="local-database-help">
            {onConnectAgent
              ? '一键连接 AI 的工具接口，保存并发布后可用。'
              : '请先在画布添加一个 AI Agent，或拖动工具接口连线。'}
          </p>
        </div>
      )}
    </div>
  );
}
