---
"@agentproto/runtime": minor
---

Migrate the app/task/tunnel batch of list tools onto the `ToolTransformer` mechanism (`defineTool` + `implementTool` + `toMcpTool` with `paginated`/`catchErrors`), replacing hand-rolled `pageParamsShape` handlers whose `compact`/`fields` params were silently ignored:

- `tunnel_list`, `app_list`, `app_list_applied`, `task_list`, `app_data_list`, `app_external_list` now COMPACT by default via a real per-tool `project()` projection (`full: true` / `compact: false` returns the old verbose records), and `fields` is a per-item allowlist on the paginated branch. `app_data_list`/`app_external_list` entries are already minimal, so their projection is the identity — the win there is `fields` + the contract-layer registration. Error handling on all six is wrapped in `catchErrors()` (unexpected throws become the canonical MCP error result); tool-declared guard/error replies keep their exact legacy shapes.
- Legacy default envelopes are preserved byte-for-byte: `tunnel_list` → `{tunnels}`, `task_list` → `{boardId, tasks}`, `app_data_list` → `{appId, dir, entries}`, `app_external_list` → `{appId, root, path, entries}`, `app_list`/`app_list_applied` → bare arrays. Pagination (limit/cursor, cursor semantics, maxLimit 200) is unchanged. Tools whose legacy default body isn't `paginated`'s `{items}` wrapper carry a small local `paginatedLegacyList` companion transformer (per file, alongside the plan-noted copy-pasted `textResult`/`errorResult` helpers); hand-rolled scoping logic elsewhere is untouched.
