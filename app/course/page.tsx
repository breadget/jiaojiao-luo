import type { Metadata } from 'next';
import { AiWorkspace } from '@/components/ai/ai-workspace';

export const metadata: Metadata = {
  title: '询问 AI 智能体 · Urtoris',
  description: '在同一段对话里询问课程知识、调用工作流，共用一个 AI 模型。',
};

export default function CoursePage() {
  return <AiWorkspace />;
}
