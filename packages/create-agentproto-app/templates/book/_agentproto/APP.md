---
schema: app/v1
id: '__APP_ID__'
name: __APP_NAME__
version: 0.1.0
description: >-
  __APP_NAME__ — scaffolded by create-agentproto-app.
category: book
library:
  books:
    - id: '__APP_SLUG__'
      title: __APP_NAME__
agents:
  - id: '__APP_SLUG__-assistant'
    path: .agentproto/agents/__APP_SLUG__-assistant/AGENT.md
workflows:
  - id: __APP_SLUG__-flow
    path: .agentproto/workflows/__APP_SLUG__-flow/WORKFLOW.md
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
---

__APP_NAME__ — scaffolded by create-agentproto-app. Edit this file, the
agent, and the workflow below to make the book yours. The `.claude/skills/
install-agentproto-app/` skill this template ships is the tier-1 install
path for buyers — it just shells out to `agentproto app install .`.
