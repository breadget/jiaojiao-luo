import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeKnowledgeEvidence } from '../components/ai/knowledge-evidence';

test('persisted evidence keeps only bounded public PDF references', () => {
  const evidence = sanitizeKnowledgeEvidence({
    mode: 'llm',
    apiKey: 'must-not-persist',
    baseUrl: 'https://private.example',
    warning: '源文档已更新',
    sources: [
      {
        id: 'chunk-1',
        filename: '课程.pdf',
        page: 8,
        excerpt: '队列先进先出。',
        score: 0.8,
        token: 'must-not-persist',
      },
    ],
  });
  assert.deepEqual(evidence, {
    mode: 'llm',
    warning: '源文档已更新',
    sources: [
      {
        id: 'chunk-1',
        filename: '课程.pdf',
        page: 8,
        excerpt: '队列先进先出。',
        score: 0.8,
      },
    ],
  });
});

test('invalid stored references cannot become a source link', () => {
  assert.equal(
    sanitizeKnowledgeEvidence({ mode: 'n8n', sources: [] }),
    undefined,
  );
  assert.equal(sanitizeKnowledgeEvidence(null), undefined);
  const evidence = sanitizeKnowledgeEvidence({
    mode: 'retrieval_only',
    sources: [
      {
        id: 'bad',
        filename: '课程.pdf',
        page: -1,
        excerpt: '无效',
        score: 0.9,
      },
      {
        id: 'good',
        filename: '课程.pdf',
        page: 1,
        excerpt: '原文',
        score: Number.NaN,
      },
    ],
  });
  assert.deepEqual(evidence?.sources, [
    { id: 'good', filename: '课程.pdf', page: 1, excerpt: '原文', score: 0 },
  ]);
});

test('recovered no-match evidence preserves its honest result and text limits', () => {
  const evidence = sanitizeKnowledgeEvidence({
    mode: 'no_match',
    sources: [],
    warning: 'x'.repeat(1000),
  });
  assert.equal(evidence?.mode, 'no_match');
  assert.equal(evidence?.warning?.length, 600);
  assert.deepEqual(evidence?.sources, []);
});
