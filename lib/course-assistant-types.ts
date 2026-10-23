/** Public course Q&A contract. Provider credentials never belong here. */
export type CourseSource = {
  id: string;
  filename: string;
  page: number;
  excerpt: string;
  score: number;
};

/** Evidence only: answer generation belongs to the main site's shared agent. */
export type CourseRetrieval = {
  question: string;
  sources: CourseSource[];
};

export type CourseStatus = {
  ready: boolean;
  has_index?: boolean;
  stale?: boolean;
  document_count: number;
  page_count: number;
  chunk_count: number;
  documents: Array<{ name: string; pages: number | null }>;
  llm_configured: boolean;
  embedding_backend?: string;
  embedding_model?: string;
  indexed_at?: string | null;
};

export type CourseAnswer = {
  question: string;
  answer: string;
  sources: CourseSource[];
  mode: 'llm' | 'retrieval_only' | 'no_match';
  warning?: string;
};
