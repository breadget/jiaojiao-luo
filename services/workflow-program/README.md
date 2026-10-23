# Workflow program service

This Node service executes validated published canvas graphs independently of the browser. It listens only on `127.0.0.1` and requires the same bearer token as the main site's program client. Do not expose port 8030 through the reverse proxy.

Start with `WORKFLOW_PROGRAM_TOKEN` (at least 32 characters) set, then run `bash scripts/program-dev.sh`. The token must match the main application. The production entry point is `node --import tsx services/workflow-program/server.ts`; Node 22.13 or newer and the project's `tsx` dependency are required.

Configuration:

| Variable                     | Default                          | Purpose                                           |
| ---------------------------- | -------------------------------- | ------------------------------------------------- |
| `WORKFLOW_PROGRAM_TOKEN`     | required                         | Shared internal service bearer token              |
| `WORKFLOW_PROGRAM_PORT`      | `8030`                           | Loopback listener port                            |
| `WORKFLOW_PROGRAM_STATE_DIR` | absolute `work/workflow-program` | Persistent job snapshots and generated text files |
| `COURSE_ASSISTANT_URL`       | `http://127.0.0.1:8001`          | Fixed loopback Django course backend origin       |

The main application uses `WORKFLOW_PROGRAM_URL=http://127.0.0.1:8030` and the matching token. Browser ownership checks belong to the main application; its browser token is never forwarded to this service.

HTTP endpoints:

- `GET /health`: public local health check.
- `POST /v1/jobs`: internal `ProgramStartRequest`, returns `202` and a `ProgramJob` directly.
- `GET /v1/jobs/:id`: current durable `ProgramJob` directly.
- `DELETE /v1/jobs/:id`: cancel queued or active work.
- `GET /v1/jobs/:id/artifacts/:artifactId`: attachment download for a file recorded on that job.

There are at most two running jobs and eight queued jobs, with a five minute execution limit. Request bodies are capped at 512 KiB, individual text files at 1 MiB, and file totals at 5 MiB per job. Provider calls and course retrieval have bounded response bodies and cancellation. Course retrieval creates its own Django CSRF session and sends only the question, without model keys.

Only sanitized public snapshots and generated artifacts are persisted, with atomic writes and private file modes. Provider credentials and executable plans stay in memory. Reusing an ID with identical graph, input, version, and nonsecret model settings returns the stored job; a mismatch returns `409`. Queued/running snapshots found on startup become `failed` with `WORKER_RESTARTED` and are never automatically executed again.

For production, run `python3 deploy/setup-workflow-program.py` as root from reviewed new source, then install the updated restricted deploy entry point as described in `deploy/README.md`. Preparation creates the `urtoris-program` user in group `urtoris`, the private state directory, and matching server-only tokens in the worker environment and site configuration. It enables the unit without starting or restarting a service and works while the current production release still lacks worker source. Keep the state directory outside release checkouts and back it up with other application state. The unit deliberately permits writes only in that directory.

Offline checks: `node --experimental-test-module-mocks --import tsx --import ./tests/helpers/loader-hooks.mjs --test tests/workflow-program-service.test.ts`.
