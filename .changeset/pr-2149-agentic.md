---
"@agentproto/runtime": minor
---

PR provenance is fixed to the sessions that actually wrote the code, not the session that ran `gh pr create`.

- The footer renders an "Authored by" entry per session that committed to the PR's head branch — each with its own adapter, auth profile, model, sandbox provider and per-session cost — plus an "Opened by" entry for the session that opened the PR. The opener's cumulative cost/tokens are suppressed when authorship is attributed.
- Authorship is collected per branch from sandbox delivery targets, `Agentproto-Session:` trailers on the PR's commits, and the checkpoint-branch tip (through the configured `refPrefix`), so a branch stays attributable after the registry forgets the box session.
- The teardown delivery stamps the authoring-session trailer onto the pushed work branch itself via an idempotent `commit-tree` + guarded `update-ref`, so it survives checkpoint deletion.
- New daemon `pr_open` tool: the host runs `gh pr create` against a named authoring session's pushed branch, stamps the authorship-aware footer, and records the PR against that session; `OpenPrForSessionInput` now keys checkpoint reads off the PR's actual `headRefName`.
- `openPrForSession` is exported from `@agentproto/runtime` so CLI/HTTP lanes can open PRs on behalf of a box session.
