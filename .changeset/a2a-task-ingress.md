---
"@agentproto/runtime": patch
---

Add A2A task ingress: `POST /a2a/apps/:appId` speaks JSON-RPC 2.0 (`message/send`, `tasks/get`, `tasks/cancel`). `message/send` starts an `app_run` for an agent the app lists under `exposes.agents` and requires `accepts.tasks: true` in the manifest (otherwise error `-32004`); the task id is the app run id, task state is derived from the run, and `tasks/get` returns the app's artifact once the run completes. Created tasks are recorded in an append-only ledger at `<stateDir>/a2a-tasks/<appId>.jsonl`.
