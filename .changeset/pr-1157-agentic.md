---
"@agentproto/cli": minor
---

Add stage board feature: a dependency-free ES module served at `GET /agentproto/stageboard.js` from `app serve` and `app dev` that renders an app's state ledger as an interactive UI component. Exports `toRows(snapshot, events)` for pure fold logic (snapshot + ledger events → board rows), `unwrapToolResult(result)` for unwrapping nested MCP response shells, and `mountStageBoard(el, opts)` for mounting a live board into an element with auto-refresh, approval flow, and CSS variable theming.
