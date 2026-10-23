import type { Metadata } from 'next';
import { AiWorkspace } from '@/components/ai/ai-workspace';

export const metadata: Metadata = {
  title: '询问 AI 智能体 · Urtoris',
  description: '在同一工作台询问课程知识，或装载工作流与 AI 智能体对话。',
};

export default function CoursePage() {
  return <AiWorkspace initialMode="knowledge" />;
}
