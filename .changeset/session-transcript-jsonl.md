---
"@agentproto/acp": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Persist a structured, per-session transcript at capture time so agentproto gets Claude Code's "one durable transcript, many renderers" property instead of losing every ACP event to the ANSI ring buffer.

- `@agentproto/acp`: add `plan` and `usage_update` to the `StreamEvent` union and wire them through `translateSessionUpdate` — previously both were received over the wire and silently dropped before ever becoming a `StreamEvent`.
- `@agentproto/runtime`: new `transcript-writer.ts` taps the ACP event stream in `sessions.ts` right before `projectEvent` flattens it into the ring buffer, appending one JSON object per line to `~/.agentproto/sessions/<sessionId>/events.jsonl` (coalescing text-delta/thought chunks the same way the ring buffer does, flushing on turn boundaries and a short debounce). `projectEvent` renders `plan` as a `[plan] done/total ...` line and ignores `usage_update`. `transcript-export.ts` gains a daemon-events reader that folds the JSONL back into the existing `ExportedSession` model, and `exportAgentSession` takes a `source: "auto" | "native" | "daemon"` param — `auto` (default) prefers an adapter's native store (claude-code JSONL / hermes SQLite) and falls back to the daemon's own capture when there isn't one or it can't be read.
- `@agentproto/cli`: `sessions export` gets a `--source auto|native|daemon` flag, plumbed the same way through the `agent_export` MCP tool and `GET /sessions/:id/export`.

Design notes:
- The writer's per-session transcript directory defaults to `~/.agentproto/sessions`, overridable via `createSessionsRegistry({ transcriptDir })` (defaults to a `sessions` sibling of `persistPath` otherwise) — this is what let every existing test that drives a spawned agent through a tmp `persistPath` get transcript isolation for free.
- ACP's own `agent-prompt` `StreamEvent` kind means "the agent is asking the human a question" (an unimplemented `requestPermission` surfacing) — NOT "a prompt was sent to the agent". To keep turns reconstructable without overloading that name, outgoing prompts are recorded under a separate `user-prompt` kind, local to the writer.
- PTY (`terminal`) and `command` sessions are unaffected — they have no structured event source, so this only ever engages for `agent-cli` sessions.
- No rotation/GC in v1 — `events.jsonl` grows unboundedly per session. A `sessions gc` (or similar) follow-up is left as an explicit next step rather than folded in here.

Live-verified against an isolated `agentproto serve` instance (separate port + `$HOME`, symlinked `.claude` for auth, never touching the real shared daemon): spawned a real `claude-code` session, watched `events.jsonl` grow with `user-prompt` → `usage_update` → `text-delta` (including a debounce-triggered partial flush) → `turn-end`, exported clean markdown via `source=daemon`, and confirmed `source=auto` correctly falls back to daemon events for this adapter (the ACP wrapper spawned by the daemon doesn't write the native `~/.claude/projects/**/*.jsonl` file the interactive `claude` CLI does, so native export 404s and daemon-events is the only backend that actually works here) — then killed and restarted the isolated daemon and confirmed export still works from the persisted file alone.
