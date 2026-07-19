---
name: Agentproto Agent Verb
id: agentproto-agent-verb
description: >
  Parameterized sandboxed agentflow verb. `pr` implements a free-text request
  (or a GitHub issue) and OPENS a pull request; `fix` applies the latest
  review's requested changes to a PR (fixDelivery: pr = stacked bot/fix-<n>
  PR, commit = push to the head branch). One workflow for all
  change-authoring verbs — the verb input selects the prompt and the
  delivery; the sandbox machinery (e2b boot, adapter install, auth env
  passthrough, gh-free curl-REST delivery) is shared with the pr-review
  workflow via ../lib/sandbox-agent.mjs.
version: 0.1.0
entry: ./entry.mjs
inputs:
  verb:
    type: string
    description: Agent verb — pr | fix (implement = alias of pr).
  prNumber:
    type: number
    description: PR number (fix; or pr triggered from a PR comment).
    default: 0
  issueNumber:
    type: number
    description: Issue number (pr/implement on an issue).
    default: 0
  requestText:
    type: string
    description: Free-text request for the pr verb.
    default: ""
  baseRef:
    type: string
    description: Base branch ref.
    default: main
  headRef:
    type: string
    description: PR head branch (fix verb).
    default: ""
  repo:
    type: string
    description: owner/repo slug — required for the sandbox bootstrap clone.
    default: ""
  githubToken:
    type: string
    description: >
      Unused placeholder for parity with pr-review — the box receives
      GITHUB_TOKEN via the sandbox env passthrough, never via input.
    default: ""
  reviewConfig:
    type: object
    description: Parsed .github/agentic-review.json config.
outputs:
  delivered:
    type: string
    description: pr | commit — how the change landed.
  error:
    type: string
    description: Error message if the verb failed.
steps:
  - id: work
    kind: agent
    adapter: claude-sdk
---

# Agentproto Agent Verb

One-step agentflow that carries a change-authoring verb inside a single
sandboxed agent session. The box clones the repo itself (Phase 0), reads the
verb's configured skills from the clone, implements, and delivers via pure
git + curl REST (the box has no `gh` CLI):

- **pr**: implement `requestText` (or issue `issueNumber`) on a `bot/…`
  branch off `baseRef`, open a PR via `POST /repos/:repo/pulls`.
- **fix**: read the latest review of `prNumber` via REST, apply the
  requested changes; `commands.fix.fixDelivery` picks the landing —
  `pr` (default) opens a stacked `bot/fix-<n>` PR based on the PR's head
  branch, `commit` pushes directly to the head branch.

Config source of truth is `.github/agentic-review.json`: the global lane
keys (`reviewerAdapter`, `reviewerSandbox`, `reviewerSandboxEnv`) plus
per-verb `commands.<verb>` overrides (`skills`, `fixDelivery`).

Dispatched by `.github/workflows/agent-command.yml` on `/pr`, `/implement`,
and `/fix` slash-commands (same convention as `/review`); the legacy
runner-side agent loop in `scripts/agent-command.mjs` remains the fallback
when the sandbox lane is unconfigured or fails.
