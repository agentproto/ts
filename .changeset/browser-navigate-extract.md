---
"@agentproto/adapter-browser-chrome": minor
"@agentproto/adapter-browser": minor
"@agentproto/runtime": minor
---

chrome-live gains the read path that `start_browser` always lacked: `navigateOwnedTarget(url, targetId?)` reuses an existing agent-owned tab (or opens one via `attach({ initialUrl })`) and `domOwnedTarget(targetId?)` serializes it (`driver.getDom()`) — both guarded by the same ownership rule as `screenshotOwnedTarget`, never a foreign tab. `@agentproto/adapter-browser`'s `BrowserAdapterInstance` exposes these as optional `navigate`/`getDom`, wired for chrome-live.

`@agentproto/runtime` adds three MCP tools: `fetch_page` (plain HTTP read, no browser — `{ title, text, url, blocked }`, `blocked: true` on a 403/429/503/401/407 or a known anti-bot challenge fingerprint from Cloudflare/Akamai/PerimeterX/Datadome/Incapsula), and chrome-live-only `browser_navigate` / `browser_extract_text` built on the new owned-target methods. `browser_extract_text` and `fetch_page` both purify their HTML with a small Defuddle wrapper (`page-text.ts`) — mirrors `@agentproto/bureau-purify`'s approach rather than depending on it, so the daemon's core runtime stays free of a dependency on a downstream product package.
