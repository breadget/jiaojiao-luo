import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Urtoris Workflow Studio',
  description: '为 AI Agent 与机器人编排、验证并观察工作流草稿。',
};

const directionContract = `
THESIS: 工作流不是顺序表，而是一张把主执行、模型、记忆、工具和条件分支同时说清楚的可运行图。
OWN-WORLD: 夜间机器人调度台——黑蓝画布、精密端口色、深海军蓝面板与安全橙命令；状态靠边线、图标和文字共同表达。
STORY: 创建者从节点库拖入能力、按语义端口连接、在 Inspector 配置，再保存 Graph 草稿；兼容运行只检查既有绑定与 requestId，节点级真实事件要等 Adapter 接入。
FIRST VIEWPORT: 64px 命令栏下，左侧节点库、中央无限画布、右侧 Inspector 与底部运行面板同时可见；Agent 和四个资源连接占据画布中心。
FORM: code-led build；seed-key: urtoris-workflow-studio-2026-09-11；既有 Urtoris 世界内的 Workflow Studio 专属操作面。
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <script
          dangerouslySetInnerHTML={{
            __html: `document.currentScript?.before(document.createComment(${JSON.stringify(directionContract)}));`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.addEventListener('error',function(event){if(typeof event.message==='string'&&event.message.startsWith('ResizeObserver loop')){event.preventDefault();event.stopImmediatePropagation();}},true);`,
          }}
        />
        {children}
      </body>
    </html>
  );
}
