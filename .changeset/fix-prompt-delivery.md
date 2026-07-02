---
"@agentproto/runtime": patch
---

Fix two prompt-delivery reliability bugs found while orchestrating real sessions:

1. **Prompt to a dead session silently "succeeded"** — MCP `agent_prompt` fired `sendPrompt` without awaiting it, so a killed/exited/errored session always returned `{ok: true, queued: true}` even though the prompt never went anywhere. `sendPrompt`/`enqueuePrompt` now throw a structured `SessionNotAliveError` (carrying the actual `status`) when the target session isn't alive after a resume attempt, and both ingress paths — MCP `agent_prompt` and HTTP `POST /sessions/:id/prompt` (both `wait` modes) — await that check before reporting success. HTTP maps it to `409 {error: "session_not_alive", status}`; MCP surfaces it as a tool error with a clear message.

2. **Concurrent prompts on a busy session dropped one silently** — the same fire-and-forget pattern in `agent_prompt` swallowed the existing "mid-turn" busy rejection. `enqueuePrompt` is now async: it awaits admission (resume attempt + the missing/wrong-kind/dead/busy checks `sendPrompt` already threw) before resolving, only firing the turn's own execution unawaited — so a prompt racing an in-flight turn on any protocol arm (acp-client, print-arm, proprietary — none of which can accept a second concurrent turn) now surfaces a loud, retryable busy error instead of vanishing. Consistent across MCP and HTTP since both call the same `enqueuePrompt`.
