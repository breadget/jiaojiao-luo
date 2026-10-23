/** node --import tsx deploy/n8n/forward-graph-executions.ts <clone-root> [--once] */
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import {
  executionDataEvents,
  type ExecutionSnapshot,
  type RuntimeManifest,
} from '../../lib/workflow-graph/execution-data-events';

const root = process.argv[2];
if (process.env.URTORIS_CLONE_CANARY !== '1' || !root || !isAbsolute(root))
  throw new Error('CLONE_MARKER_REQUIRED');
const resolvedRoot = realpathSync(root);
const config = JSON.parse(
  readFileSync(join(resolvedRoot, 'graph-runtime-clone.json'), 'utf8'),
) as {
  marker: string;
  n8nVersion: string;
  database: string;
  n8nPackage: string;
  eventsUrl: string;
  workflows: RuntimeManifest[];
};
if (
  config.marker !== 'isolated-urtoris-graph-canary' ||
  config.n8nVersion !== '2.38.6'
)
  throw new Error('INVALID_CLONE_MARKER');
const databasePath = realpathSync(join(resolvedRoot, config.database));
const within = relative(resolvedRoot, databasePath);
if (within.startsWith('..') || isAbsolute(within))
  throw new Error('DATABASE_OUTSIDE_CLONE');
const endpoint = new URL(config.eventsUrl);
if (
  endpoint.protocol !== 'http:' ||
  endpoint.hostname !== '127.0.0.1' ||
  endpoint.port !== '3000' ||
  endpoint.pathname !== '/api/n8n/events' ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search
)
  throw new Error('LOOPBACK_EVENTS_ONLY');
const n8nRequire = createRequire(realpathSync(config.n8nPackage));
if (JSON.parse(readFileSync(config.n8nPackage, 'utf8')).version !== '2.38.6')
  throw new Error('N8N_VERSION_MISMATCH');
const { parse } = n8nRequire('flatted') as {
  parse: (text: string) => ExecutionSnapshot['data'];
};
const token = process.env.URTORIS_INTERNAL_TOKEN;
if (!token) throw new Error('INTERNAL_CREDENTIAL_REQUIRED');
if (
  !config.workflows.length ||
  new Set(config.workflows.map((wf) => wf.externalWorkflowId)).size !==
    config.workflows.length
)
  throw new Error('INVALID_WORKFLOW_ALLOWLIST');
const db = new DatabaseSync(databasePath, { readOnly: true });
const acknowledged = new Set<string>();
let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});
try {
  do {
    for (const manifest of config.workflows) {
      const rows = db
        .prepare(`SELECT e.id, e.workflowId, e.status, e.stoppedAt, d.data, d.workflowData
        FROM execution_entity e JOIN execution_data d ON d.executionId = e.id
        WHERE e.workflowId = ? AND e.stoppedAt IS NOT NULL ORDER BY e.id`)
        .all(manifest.externalWorkflowId) as Array<{
        id: number;
        workflowId: string;
        status: string;
        stoppedAt: string;
        data: string;
        workflowData: string;
      }>;
      for (const row of rows) {
        if (acknowledged.has(String(row.id))) continue;
        const snapshot: ExecutionSnapshot = {
          ...row,
          id: String(row.id),
          stoppedAt: Date.parse(
            row.stoppedAt +
              (/Z$|[+-]\d\d:\d\d$/.test(row.stoppedAt) ? '' : 'Z'),
          ),
          data: parse(row.data),
          workflowData: JSON.parse(row.workflowData),
        };
        const events = executionDataEvents(snapshot, manifest);
        if (!events.length) continue;
        for (const event of events) {
          const response = await fetch(endpoint, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(10000),
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(event),
          });
          const ack = (await response.json()) as {
            ok?: boolean;
            bound?: boolean;
            sourceSeq?: number;
          };
          if (
            response.status !== 200 ||
            ack.ok !== true ||
            ack.sourceSeq !== event.sourceSeq ||
            (event.sourceSeq === 0 && ack.bound !== true)
          )
            throw new Error(`EVENT_ACK_REJECTED:${response.status}`);
        }
        acknowledged.add(String(row.id));
        console.log(
          JSON.stringify({
            executionId: String(row.id),
            events: events.length,
            terminal: events.at(-1)?.eventType,
          }),
        );
      }
    }
    if (process.argv.includes('--once')) break;
    if (!stopping) await setTimeout(1500);
  } while (!stopping);
} finally {
  db.close();
}
