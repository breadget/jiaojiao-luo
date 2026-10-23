import type { Metadata } from 'next';
import { AiWorkspace } from '@/components/ai/ai-workspace';

export const metadata: Metadata = {
  title: '询问 AI 智能体 · Urtoris',
  description: '课程知识与工作流融入同一段 AI 对话，共用模型设置和原文依据。',
};

export default function AiPage() {
  return <AiWorkspace />;
}
