---
schema: app/v1
id: '@agentproto/session-steward'
name: Session Steward
version: 0.1.0
description: >-
  Tells you which live sessions need you (a reply, an unblock, a restart, a
  close): a read-only, prioritized attention digest. Also wraps up idle agent
  sessions (legacy, `--wrapup`): classifies them with session_wrapup_plan,
  closes the rule-certain ones, has a cheap one-shot judge decide the
  ambiguous ones from compact evidence, and closes or flags confident
  verdicts with a recorded outcome. Dry run by default.
agents:
  - id: '@agentproto/session-steward-judge'
    path: .agentproto/agents/session-steward-judge/AGENT.md
  - id: '@agentproto/session-attention-judge'
    path: .agentproto/agents/session-attention-judge/AGENT.md
workflows:
  - id: session-steward
    path: .agentproto/workflows/session-steward/WORKFLOW.md
  - id: session-attention
    path: .agentproto/workflows/session-attention/WORKFLOW.md
skill:
  path: skill
---

Wraps up idle agent sessions — see README.md for how to install and run it,
and `routines/` for the hourly scheduled template (ships disabled).
