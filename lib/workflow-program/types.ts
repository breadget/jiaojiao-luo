import type { CourseSource } from '@/lib/course-assistant-types';
import type { LlmConfig } from '@/lib/workflow-types';
import type { WorkflowGraphV1 } from '@/lib/workflow-graph/types';

/** The worker and its main-site client share one public snapshot size contract. */
export const PROGRAM_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

export type ProgramInputField = {
  name: string;
  label: string;
  type: 'text' | 'number' | 'boolean';
  required?: boolean;
  default?: string | number | boolean;
  min?: number;
  max?: number;
};

export type ProgramPlan = {
  schemaVersion: 1;
  workflowId: string;
  workflowVersion: number;
  graph: WorkflowGraphV1;
  inputFields: ProgramInputField[];
  executionNodeIds: string[];
  resourceNodeIds: string[];
};

export type ProgramNodeSnapshot = {
  id: string;
  name: string;
  state: 'waiting' | 'running' | 'success' | 'error' | 'skipped';
  startedAt?: number;
  finishedAt?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
};

export type ProgramArtifact = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

export type ProgramResult = {
  /** Present only when a model actually generated output in this job. */
  model?: { provider: string; model: string };
  text: string;
  sources: CourseSource[];
  data?: unknown;
};

export type ProgramJob = {
  id: string;
  workflowId: string;
  workflowVersion: number;
  versionId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  input: Record<string, unknown>;
  nodes: Record<string, ProgramNodeSnapshot>;
  result: ProgramResult | null;
  artifacts: ProgramArtifact[];
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error?: { code: string; message: string };
};

/** Internal only. LLM credentials are transient and must never enter a job snapshot. */
export type ProgramStartRequest = {
  /** Internal dispatch deadline; never a browser override. */
  dispatchExpiresAt?: number;
  id: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: number;
  versionId: string;
  plan: ProgramPlan;
  input: Record<string, unknown>;
  llm: LlmConfig;
};

export type ProgramDescription = {
  workflowId: string;
  name: string;
  versionId: string;
  workflowVersion: number;
  inputFields: ProgramInputField[];
  nodes: Array<{ id: string; name: string; type: string }>;
  requiresModel: boolean;
};
