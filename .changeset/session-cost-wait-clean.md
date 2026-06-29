---
"@agentproto/runtime": minor
"@agentproto/adapter-hermes": minor
"@agentproto/cli": minor
---

Agent-friendly session ergonomics: cost/usage visibility + cap, one-shot wait, clean output, model echo, race-free wait cursor.

- **Cost / tokens on the session** (`SessionDescriptor.costUsd` / `tokensIn` / `tokensOut`): refreshed best-effort at each turn-end via an adapter-supplied `readUsage` hook. hermes implements it by reading its `state.db` (with a short retry to ride out the post-turn cost write). Surfaced on the descriptor → visible in `list_sessions` / `get_agent_session_output` / the spawn response.
- **Per-session cost cap** (`start_agent_session({ maxCostUsd })`): when a turn-end pushes cumulative cost over the ceiling, the session is stopped (best-effort, turn-granular) with a `[cost-cap]` notice.
- **Model echo** (`SessionDescriptor.model`): the requested model is recorded and echoed back at spawn — no `state.db` round-trip to confirm what's running.
- **One-shot `start_agent_session({ wait: true })`**: blocks until the first turn completes and returns the cleaned output inline — collapses the spawn → `wait_for_any` → `get_agent_session_output` dance into one call.
- **`get_agent_session_output({ clean: true })`**: strips ANSI + `── … ──` framing + `[thought]`/`[tool]` markers for plain, parseable text (shared with the `wait` output).
- **`wait_for_any({ since })`**: an event-ring cursor makes the wait race-free for already-emitted events (complements the descriptor fast-path).

Robustness: `wait` / `clean` / `maxCostUsd` accept stringified scalars (MCP clients often stringify booleans/numbers). The hermes `node:sqlite` import is built via a runtime-computed specifier so the bundler can't strip the `node:` prefix off the Node-22 builtin.
