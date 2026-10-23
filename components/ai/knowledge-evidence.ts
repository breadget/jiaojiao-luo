import type { CourseSource } from '@/lib/course-assistant-types';
import type { ChatKnowledgeEvidence } from '@/lib/workflow-types';

export type KnowledgeEvidence = ChatKnowledgeEvidence;

/** Only public PDF evidence is allowed into conversation metadata. */
export function sanitizeKnowledgeEvidence(
  value: unknown,
): KnowledgeEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.mode !== 'llm' &&
    record.mode !== 'retrieval_only' &&
    record.mode !== 'no_match'
  )
    return undefined;
  const sources: CourseSource[] = Array.isArray(record.sources)
    ? record.sources.slice(0, 8).flatMap((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
          return [];
        const source = value as Record<string, unknown>;
        if (
          typeof source.id !== 'string' ||
          !source.id.trim() ||
          typeof source.filename !== 'string' ||
          !source.filename.trim() ||
          typeof source.page !== 'number' ||
          !Number.isInteger(source.page) ||
          source.page < 1 ||
          typeof source.excerpt !== 'string' ||
          !source.excerpt.trim()
        )
          return [];
        return [
          {
            id: source.id.slice(0, 200),
            filename: source.filename.slice(0, 260),
            page: source.page,
            excerpt: source.excerpt.slice(0, 2000),
            score:
              typeof source.score === 'number' && Number.isFinite(source.score)
                ? source.score
                : 0,
          },
        ];
      })
    : [];
  const warning =
    typeof record.warning === 'string'
      ? record.warning.trim().slice(0, 600)
      : '';
  return { mode: record.mode, sources, ...(warning ? { warning } : {}) };
}
