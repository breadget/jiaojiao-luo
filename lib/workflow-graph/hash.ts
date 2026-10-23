/**
 * 内容哈希。
 *
 * 用规范 JSON（递归排序对象键）而不是 JSON.stringify，是因为哈希要表达的
 * 是"内容相同"，不是"键的插入顺序相同"。
 *
 * 另外把**只随时间变化的字段**（revision、metadata.updatedAt）归一化掉：
 * 它们每保存一次就变，如果算进哈希，同一份画布保存两次会得到两个哈希，
 * 于是"编译预览的 hash 等于发布后的 hash"这种承诺就不成立了。
 */
import type { WorkflowGraphV1 } from '@/lib/workflow-graph/types';

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child === undefined) continue;
      sorted[key] = sortValue(child);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** 归一化掉易变字段后，参与哈希的那一份 Graph。 */
export function graphContentForHash(graph: WorkflowGraphV1): WorkflowGraphV1 {
  return {
    ...graph,
    revision: 0,
    metadata: { ...graph.metadata, updatedAt: 0 },
  };
}

/** Graph 草稿 / 发布快照的内容哈希。 */
export function hashGraphContent(graph: WorkflowGraphV1): Promise<string> {
  return sha256Hex(canonicalJson(graphContentForHash(graph)));
}
