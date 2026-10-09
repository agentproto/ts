---
"@agentproto/apps": patch
"@agentproto/runtime": patch
"@agentproto/workflow-loader": patch
---

Session steward: a PR is not proof a session is finished. A would-be `done` close is now downgraded to a flag (`needs-input`) when the last assistant message asks the user a question, announces a next action or leaves work pending — this includes the `parentEnded` path that closed children holding an open question to a dead parent. The terminal-session relabel gains `needs-follow-up` (open PR still awaiting review/merge) and PR numbers are repo-qualified (`owner/repo#N`). The loop rule no longer counts recursive `rg`/`grep` over a directory as a repeated file read, and the zero-candidate report breaks exclusions down per reason.

Runtime: `session_wrapup_plan` evidence carries `worktree.pr` state (`open`/`merged`/`closed`) and a `worktreePrOpen` signal; a fresh `starting` session that is not stuck is kept instead of sent to the judge.

Workflow loader: the workflow entry's relative imports are versioned with the entry (`agentproto_v`), so editing a helper next to `entry.mjs` is picked up on the next run instead of being served from Node's module cache.
