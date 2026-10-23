'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { WorkflowLab } from '@/components/workflow-lab';
import styles from './ai-workspace.module.css';

/** Course evidence and workflow tools share the same conversation and model. */
export function AiWorkspace() {
  return (
    <div className={styles.workspace}>
      <header className={styles.header}>
        <Link
          href="/"
          prefetch={false}
          className={styles.home}
          aria-label="返回 Urtoris 工作台"
          onClick={(event) => {
            if (
              event.button ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            window.location.assign('/');
          }}
        >
          <ArrowLeft aria-hidden="true" />
          <span>Urtoris</span>
        </Link>
        <h1>询问 AI 智能体</h1>
      </header>
      <main className={styles.panels}>
        <WorkflowLab initialPortal="consumer" embedded unifiedAssistant />
      </main>
    </div>
  );
}
