---
"@agentproto/runtime": patch
---

Add A2A 1.0 task ingress: `POST /a2a/apps/:appId` speaks JSON-RPC 2.0 (`SendMessage`, `GetTask`, `CancelTask`) with 1.0 shapes (flat parts, `ROLE_*` roles, `TASK_STATE_*` states, `{task}` response wrapper) and `A2A-Version` / `?version=` negotiation (defaults to `1.0` when neither is sent; an explicit unsupported version such as `0.3` gets `-32009`). `SendMessage` starts an `app_run` for an agent the app lists under `exposes.agents` and requires `accepts.tasks: true` in the manifest (otherwise error `-32004`); the task id is the app run id, task state is derived from the run, and `GetTask` returns the app's artifact once the run completes. The app id in the path may be URL-encoded or literal-slash. Created tasks are recorded in an append-only ledger at `<stateDir>/a2a-tasks/<appId>.jsonl`.
