---
"@agentproto/runtime": minor
"@agentproto/apps": patch
"@agentproto/cli": patch
---

Sessions past the boot-history cap are reachable again, and review/workflow noise is grouped.

**Cold history fallback.** `HISTORY_CAP` bounds how many sessions the registry reinflates at boot; older ones kept their `index.json` sidecar and `events.jsonl` transcript but no tool could return them. `session_list` now serves them with `includeCold: true` (and automatically when a `q` matches nothing live), `session_search` searches them the same way, `session_recap` recaps a cold id, and `conversation_read` resolves a registry miss from disk — enriched by the `conversations.jsonl` link index so the conversation-id ladder binds exactly instead of searching by cwd. Cold rows are terminal records (`pid: null`, `alive: false`, flagged `cold: true`), honour every filter exactly like live rows, are never merged into a non-empty live result, and are skipped for a subtree-scoped caller. Backed by a 30s-TTL scan cache (`session-cold-list.ts`). `session_search`'s cursor also stops returning an empty page 2: the handler no longer pre-slices the rows the `paginated` transformer pages over.

**Noise-first eviction.** `loadHistorySnapshot` now spends `HISTORY_CAP` per lane — real sessions first, `review:*`/`wf:*` rows last — so a host that blew past the cap on gate-review traffic keeps its real history instead of silently evicting it under the flood.

**Review grouping.** `session_tree` and the live-session widget's `app_session_tree` collapse review-lane / workflow-stage ROOTS under one synthetic parent per checkout (`{ id: 'reviews:<key>', label: 'reviews · <key>', synthetic: true, children }`, keyed by worktree basename else workspace slug). The node is flagged `synthetic: true` — not a session, never focusable — and the widget renders it as a group header. `byOrigin` is derived from the grouped tree so the companion view mirrors it.

**Filters.** `session_list` (and `GET /sessions`) gain `label` (exact, case-insensitive) and `cwd` (boundary-aware path prefix); the CLI mirrors them as `--label` / `--cwd`.
