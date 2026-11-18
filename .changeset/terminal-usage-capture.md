---
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/adapter-claude-code": minor
"@agentproto/adapter-opencode": minor
---

Native-TUI terminal sessions (`claude`, `codex`, `opencode`, `hermes` run in a PTY) now carry model, tokens and cost like agent-cli sessions. Once the PTY is linked to its provider conversation, the daemon polls that harness's own usage journal (Claude Code transcript JSONL, Codex rollout `token_count`, `opencode.db`, hermes `state.db`) and prices the tokens against the model catalog. New `billing` (`subscription` | `api-key` | `free` | `unknown`) and `paidCostUsd` fields keep `costUsd` as the value at API price and report what the account actually pays (0 on a subscription or free model). The Claude Code and OpenCode usage readers also return the session's model.
