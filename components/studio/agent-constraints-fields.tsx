'use client';

import { ShieldCheck } from 'lucide-react';
import { useId } from 'react';
import {
  AGENT_CONSTRAINTS_MAX_LENGTH,
  agentConstraintPresets,
} from '@/lib/workflow-graph/agent-constraints';

export function AgentConstraintsFields({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const fieldId = useId();
  const existingLines = value.split('\n').map((line) => line.trim());

  return (
    <>
      <h2>
        <ShieldCheck aria-hidden="true" /> 行为限制
      </h2>
      <p id={`${fieldId}-help`} className="studio-help-copy">
        用自然语言描述这个 Agent 不能做的事、回答范围和操作前的条件。
      </p>
      <label htmlFor={fieldId}>
        <span>
          限制内容 <span className="studio-constraints-optional">（可选）</span>
        </span>
        <textarea
          id={fieldId}
          rows={6}
          maxLength={AGENT_CONSTRAINTS_MAX_LENGTH}
          value={value}
          placeholder={
            '例如：只能查询订单，不得修改或删除数据。\n超出客服范围的问题，请建议联系人工客服。'
          }
          aria-describedby={`${fieldId}-help ${fieldId}-count ${fieldId}-scope`}
          aria-invalid={
            value.length > AGENT_CONSTRAINTS_MAX_LENGTH || undefined
          }
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <div className="studio-constraints-count" id={`${fieldId}-count`}>
        {value.length.toLocaleString()} /{' '}
        {AGENT_CONSTRAINTS_MAX_LENGTH.toLocaleString()} 字符
      </div>
      <fieldset className="studio-constraints-presets">
        <legend className="sr-only">添加常用行为限制</legend>
        {agentConstraintPresets.map((preset) => {
          const next = [value.trimEnd(), preset.text]
            .filter(Boolean)
            .join('\n');
          const added = existingLines.includes(preset.text);
          return (
            <button
              key={preset.label}
              type="button"
              disabled={added || next.length > AGENT_CONSTRAINTS_MAX_LENGTH}
              title={preset.text}
              aria-label={`${added ? '已添加' : '添加'}${preset.label}限制`}
              onClick={() => onChange(next)}
            >
              {preset.label}
              {added ? ' · 已添加' : ''}
            </button>
          );
        })}
      </fieldset>
      <p id={`${fieldId}-scope`} className="studio-help-copy">
        发布后作为系统指令发送给模型。实际工具权限需在工具端设置。
      </p>
    </>
  );
}
