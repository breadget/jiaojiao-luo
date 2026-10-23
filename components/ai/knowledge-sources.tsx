import { BookOpen } from 'lucide-react';
import type { KnowledgeEvidence } from './knowledge-evidence';

export function KnowledgeSources({
  knowledge,
}: {
  knowledge: KnowledgeEvidence;
}) {
  return (
    <section className="chat-knowledge-evidence" aria-label="课程原文依据">
      <p className="chat-knowledge-state">
        <BookOpen aria-hidden="true" />
        {knowledge.mode === 'retrieval_only'
          ? '已检索课程原文 · 未使用模型生成'
          : knowledge.mode === 'no_match'
            ? '课程知识库中未找到相关依据'
            : `课程原文依据 · ${knowledge.sources.length} 处`}
      </p>
      {knowledge.warning ? (
        <p className="chat-knowledge-warning">{knowledge.warning}</p>
      ) : null}
      {knowledge.sources.map((source, index) => (
        <details
          key={`${source.id}-${index}`}
          className="chat-knowledge-source"
        >
          <summary>
            <span className="chat-knowledge-filename">
              [{index + 1}] {source.filename}
            </span>
            <span className="chat-knowledge-page">第 {source.page} 页</span>
          </summary>
          <p>{source.excerpt}</p>
        </details>
      ))}
    </section>
  );
}
