---
"@agentproto/harness": patch
"@agentproto/runtime": patch
"@agentproto/sandbox-e2b": patch
---

Fix e2b sandbox timeout issues and add poll resilience.

Root cause: e2b's per-command timeout defaults to 60s (even for `background: true` commands), killing the daemon mid-turn; sandbox lifetime defaults to 5min, reaped during long turns. Native reviewer failed on every PR, triggering fallback double-reviews.

Changes:
- **harness**: Increase MCP request timeout to long-poll window + 60s grace (client was aborting at 60s while server held 49s windows, leaving ~11s headroom)
- **runtime**: Add poll resilience — retries transient failures up to 6x; make output pulls best-effort (offset-diff safe)
- **sandbox-e2b**: Set `timeoutMs: 0` on serve command (disables per-command timeout); default sandbox lifetime to 45min (overridable); re-arm timeout on reconnect
- **ci**: Add postcheck gate (prevent duplicate reviews when native lane posts then errors post-post); add verify gate (confirm review row exists on GitHub API); integrate Langfuse tracing (soft-fail when creds absent)
