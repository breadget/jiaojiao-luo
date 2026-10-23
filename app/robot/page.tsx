import type { Metadata } from 'next';
import { RobotConsole } from '@/components/robot/robot-console';

export const metadata: Metadata = {
  title: '使用机器人 · Urtoris',
  description: '在浏览器里查看机器人画面并遥控 OpenBot 小车。',
};

export default function RobotPage() {
  return <RobotConsole />;
}
