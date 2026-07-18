---
schema: agent/v1
id: agentproto-self-review
description: Illustrative AIP-42 manifest transcribing this repo's own .github/agentic-review.json config (model, skills, escalation policy) and AGENTS.md's two hard rules into the AIP-42 per-agent manifest format. Not wired to any runtime path — nothing currently resolves a WORKFLOW.md agent step (see .github/agentproto-workflows/*/entry.mjs) against an AGENT.md. Exists to make the format's applicability concrete, and to give a real transcription target if that wiring is ever built.
version: 1.0.0
model: claude-sonnet-5
skills:
  - aip-conventions
boundaries:
  - "Never run `gh pr merge` — merge decisions are made by a human via the declared review/escalation flow, never by the reviewing/fixing agent itself."
  - "Never add an AI-attribution trailer (no `Co-Authored-By: ...`, no `Generated with ...`, or equivalent) to any commit message or PR body."
  - "Escalate to a human maintainer instead of auto-merging any change touching migrations, SQL, auth, security, GitHub Actions workflows, or `.env*` files — never attempt to bypass this escalation."
tags:
  - ci
  - review
  - illustrative
---

# agentproto-self-review

This manifest is a transcription exercise, not a live configuration. It
answers a concrete question raised while auditing whether agentproto should
have a root-level "project" manifest declaring its own agents/tools/roles:
the granular AIP-42 `AGENT.md` format already exists and is not the gap —
what's missing is any code path that resolves a `WORKFLOW.md` agent step
(`kind: "agent"`) against a file like this one. Today, `.github/agentic-review.json`
holds the review/fix bot's config as ad hoc JSON, and the newer
`.github/agentproto-workflows/*/entry.mjs` agentflows (the `agentproto-run`
CI lane) hand-type the same hard rules directly into prompt strings, because
a `WORKFLOW.md`-driven agent has no loader that reaches for an `AGENT.md`.

This file transcribes both of those into the one AIP-42 shape that could, in
principle, back either surface: `model` mirrors `agentic-review.json`'s
`model` field, `skills` mirrors its top-level `skills` array, and
`boundaries` states the two hard rules from `AGENTS.md` plus the always-escalate
policy from `agentic-review.json`'s `merge.alwaysEscalateGlobs`.

Nothing reads this file at runtime today.
