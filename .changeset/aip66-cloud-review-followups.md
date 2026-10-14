---
"@agentproto/runtime": patch
"@agentproto/adapter-claude-code-cloud": patch
---

AIP-66 cloud review follow-ups. Runtime: `watchCloudSessionMeta` now only learns a meta file whose `vendor` matches the watch (a file written for another vendor is ignored and the watch keeps polling). Adapter: `session/load` validates the session id before the repo source, so a malformed id reports its own error first; `#seedSeenEvents` pages through the whole vendor history via `resume_cursor` (bounded at 50 pages) so every pre-existing event — including an older `result` — is pre-marked, leaving `pollCursor` at the newest position the normal poll loop resumes from.
