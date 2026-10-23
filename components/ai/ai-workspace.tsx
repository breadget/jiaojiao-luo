'use client';

import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import Link from 'next/link';
import { ArrowLeft, BookOpen, Workflow } from 'lucide-react';
import { CourseAssistant } from '@/components/course/course-assistant';
import { WorkflowLab } from '@/components/workflow-lab';
import styles from './ai-workspace.module.css';

type AssistantMode = 'knowledge' | 'workflow';

/** One workbench, with the existing conversations kept intact across modes. */
export function AiWorkspace({
  initialMode = 'knowledge',
}: {
  initialMode?: AssistantMode;
}) {
  const [mode, setMode] = useState<AssistantMode>(initialMode);
  const knowledgeTab = useRef<HTMLButtonElement>(null);
  const workflowTab = useRef<HTMLButtonElement>(null);

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 'knowledge'
        : event.key === 'End'
          ? 'workflow'
          : mode === 'knowledge'
            ? 'workflow'
            : 'knowledge';
    setMode(next);
    (next === 'knowledge' ? knowledgeTab : workflowTab).current?.focus();
  }

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
        <div className={styles.tabs} role="tablist" aria-label="询问方式">
          <button
            ref={knowledgeTab}
            id="ai-tab-knowledge"
            type="button"
            role="tab"
            aria-selected={mode === 'knowledge'}
            aria-controls="ai-panel-knowledge"
            tabIndex={mode === 'knowledge' ? 0 : -1}
            onClick={() => setMode('knowledge')}
            onKeyDown={navigateTabs}
          >
            <BookOpen aria-hidden="true" />
            课程知识
          </button>
          <button
            ref={workflowTab}
            id="ai-tab-workflow"
            type="button"
            role="tab"
            aria-selected={mode === 'workflow'}
            aria-controls="ai-panel-workflow"
            tabIndex={mode === 'workflow' ? 0 : -1}
            onClick={() => setMode('workflow')}
            onKeyDown={navigateTabs}
          >
            <Workflow aria-hidden="true" />
            工作流
          </button>
        </div>
      </header>
      <main className={styles.panels}>
        <section
          id="ai-panel-knowledge"
          className={styles.panel}
          role="tabpanel"
          aria-labelledby="ai-tab-knowledge"
          hidden={mode !== 'knowledge'}
        >
          <CourseAssistant embedded />
        </section>
        <section
          id="ai-panel-workflow"
          className={styles.panel}
          role="tabpanel"
          aria-labelledby="ai-tab-workflow"
          hidden={mode !== 'workflow'}
        >
          <WorkflowLab initialPortal="consumer" embedded />
        </section>
      </main>
    </div>
  );
}
