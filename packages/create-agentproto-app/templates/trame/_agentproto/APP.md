---
schema: app/v1
id: __APP_ID__
name: __APP_NAME__
version: 0.1.0
description: >-
  __APP_NAME__ — scaffolded by `agentproto app init` (trame template): one
  agent, one workflow (agent step + gate), a single-file UI stage board, and
  a deterministic verify umbrella.
agents:
  - id: __APP_SLUG__-agent
    path: .agentproto/agents/__APP_SLUG__-agent/AGENT.md
workflows:
  - id: __APP_SLUG__-flow
    path: .agentproto/workflows/__APP_SLUG__-flow/WORKFLOW.md
data:
  dir: data
ui:
  path: .agentproto/ui/index.html
  title: __APP_NAME__
  tools:
    - app_run
    - app_status
    - app_stop
    - app_list
    - app_data_read
    - app_data_write
    - app_data_list
    - app_state_get
    - app_state_list
# One command, run from the app root, that proves the app is sound: exit 0 =
# zero error findings. `agentproto app validate` runs it last and propagates
# its exit code; the UI's Validate button tells the operator to run it.
verify:
  command: node scripts/verify.mjs
---

__APP_NAME__ — a minimal AIP app trame. Replace the agent, the workflow
steps, the gate, and this prose to make it yours. Keep the shape: every
mechanical check lives in `gates/*.mjs` behind a workflow gate step, the
durable keys are documented in `data/DATA.md`, and `scripts/verify.mjs`
stays the one umbrella that runs every gate.
