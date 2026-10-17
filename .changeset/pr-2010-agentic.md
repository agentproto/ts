---
"@agentproto/adapter-browser-chrome": minor
"@agentproto/adapter-browser": minor
"@agentproto/runtime": minor
---

chrome-live gains the read AND control path that `start_browser` always lacked, all addressing the same agent-OWNED tab (never a foreign one): `navigateOwnedTarget`/`domOwnedTarget` (read) plus `clickOwnedTarget`/`fillOwnedTarget`/`evaluateOwnedTarget`/`scrollOwnedTarget` (control) — the latter four dispatch onto the same owned driver's `click`/`fill`/`evaluate` (scroll is an `evaluate` of a generated `scrollIntoView`/`scrollTo` expression). All six go through the same ownership guard as `screenshotOwnedTarget`. `navigateOwnedTarget` now reads back the committed `document.location.href` (best-effort) so its returned url reflects redirects. `@agentproto/adapter-browser` exposes these as optional `navigate`/`getDom`/`click`/`fill`/`evaluate`/`scroll` on `BrowserAdapterInstance`, wired for chrome-live.

`@agentproto/runtime` adds the owned-tab MCP tools `fetch_page` (plain HTTP read, `{ title, text, url, blocked }`), `browser_navigate`, `browser_extract_text`, `browser_get_dom`, `browser_click`, `browser_fill`, `browser_evaluate`, `browser_scroll`. `fetch_page`/`browser_extract_text` purify HTML via a small Defuddle wrapper (`page-text.ts`); anti-bot detection is narrowed to challenge-only fingerprints so ordinary vendor-fronted pages no longer report `blocked`. The unused `projectBrowserTools` surface is renamed to `browser_kit_*` (with explicit per-`ToolSpec` `gateId`s) so it can never collide with the owned-tab tool names.
