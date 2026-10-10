---
schema: app/v1
id: '@agentproto/session-steward'
name: Session Steward
version: 0.1.0
description: >-
  Wraps up idle agent sessions: classifies them with session_wrapup_plan,
  closes the rule-certain ones, has a cheap one-shot judge decide the
  ambiguous ones from compact evidence, and closes or flags confident
  verdicts with a recorded outcome. Dry run by default. Also available as
  three composable steps over a persisted snapshot: classify (rules + Jev,
  one recommended action per session), analyze (LLM reasons for the relevant
  sessions) and act (apply by default or custom rules, origin-bounded).
agents:
  - id: '@agentproto/session-steward-judge'
    path: .agentproto/agents/session-steward-judge/AGENT.md
  - id: '@agentproto/session-steward-analyst'
    path: .agentproto/agents/session-steward-analyst/AGENT.md
workflows:
  - id: session-steward
    path: .agentproto/workflows/session-steward/WORKFLOW.md
  - id: session-steward-classify
    path: .agentproto/workflows/session-steward-classify/WORKFLOW.md
  - id: session-steward-analyze
    path: .agentproto/workflows/session-steward-analyze/WORKFLOW.md
  - id: session-steward-act
    path: .agentproto/workflows/session-steward-act/WORKFLOW.md
skill:
  path: skill
---

Wraps up idle agent sessions — see README.md for how to install and run it,
and `routines/` for the hourly scheduled template (ships disabled).
