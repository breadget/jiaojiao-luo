import type {
  ProgramDescription,
  ProgramInputField,
  ProgramJob,
} from '@/lib/workflow-program/types';
import type { LlmConfig } from '@/lib/workflow-types';

export type ProgramFormValues = Record<string, string | boolean>;

export function programDefaults(
  fields: ProgramInputField[],
): ProgramFormValues {
  return Object.fromEntries(
    fields.map((field) => [
      field.name,
      field.type === 'boolean'
        ? field.default === true
        : field.default === undefined
          ? ''
          : String(field.default),
    ]),
  );
}

/** Only published fields enter the request; browser-only draft values never become graph overrides. */
export function programInput(
  fields: ProgramInputField[],
  values: ProgramFormValues,
): Record<string, unknown> {
  return Object.fromEntries(
    fields.flatMap<[string, unknown]>((field) => {
      const raw = values[field.name];
      if (field.type === 'boolean') return [[field.name, raw === true]];
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (!text) {
        if (field.required) throw new Error(`请填写${field.label}。`);
        return [];
      }
      if (field.type === 'text') {
        if (field.min !== undefined && text.length < field.min)
          throw new Error(`${field.label}至少需要 ${field.min} 字。`);
        const limit = Math.min(field.max ?? 16000, 16000);
        if (text.length > limit)
          throw new Error(`${field.label}最多可填写 ${limit} 字。`);
        return [[field.name, text]];
      }
      const value = Number(text);
      if (!Number.isFinite(value))
        throw new Error(`${field.label}需要填写数字。`);
      if (field.min !== undefined && value < field.min)
        throw new Error(`${field.label}不能小于 ${field.min}。`);
      if (field.max !== undefined && value > field.max)
        throw new Error(`${field.label}不能大于 ${field.max}。`);
      return [[field.name, value]];
    }),
  );
}

export function programStartPayload(
  program: ProgramDescription,
  values: ProgramFormValues,
  llm: LlmConfig,
  requestId: string,
  consumerSessionId?: string | null,
) {
  return {
    workflowId: program.workflowId,
    versionId: program.versionId,
    requestId,
    input: programInput(program.inputFields, values),
    llm: {
      provider: llm.provider,
      apiKey: llm.apiKey.trim(),
      baseUrl: llm.baseUrl.trim(),
      model: llm.model.trim(),
      reasoningEffort: llm.reasoningEffort,
    },
    ...(consumerSessionId ? { consumerSessionId } : {}),
  };
}

export function programIsLive(job: ProgramJob | null) {
  return job?.status === 'queued' || job?.status === 'running';
}

export const programStatusLabels: Record<ProgramJob['status'], string> = {
  queued: '排队中',
  running: '运行中',
  completed: '已完成',
  failed: '运行失败',
  cancelled: '已取消',
};

export async function fetchProgramJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('X-Urtoris-Consumer-Client', '1');
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { cache: 'no-store', ...init, headers });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(data.error || '程序服务暂时不可用，请重试。');
  return data;
}
