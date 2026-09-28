---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

AIP-60 step 3/4: add the `local-gh` sentinel provider (zero-infra PR polling over the host's authenticated `gh` CLI), sentinel auto-link (a PR opened by a session is auto-watched, gated by `config.sentinel.autoWatchPrs` and the per-spawn `agent_start.sentinel: false` opt-out), `sentinel_watch`/`sentinel_list`/`sentinel_unwatch`/`sentinel_poll_now` MCP tools, `/sentinels` daemon HTTP routes, a new `agentproto sentinel` CLI subcommand, and a `SentinelSpec.subject` → `match[]` (OR multi-clause) contract with at-least-once delivery in the sentinel runtime.
