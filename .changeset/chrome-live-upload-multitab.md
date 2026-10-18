---
"@agentproto/adapter-browser-chrome": minor
"@agentproto/adapter-browser": minor
"@agentproto/runtime": minor
---

`chrome-live` gains two agent-surface features, exposed as new MCP tools in `@agentproto/runtime`:

- **File upload onto a real `<input type=file>`** — `browser_upload_file { sessionId, selector, paths, tabId? }` attaches local files through CDP `DOM.querySelector` + `DOM.setFileInputFiles` (the same mechanism devtools uses; the input is fed, never written back out). Every path must be absolute+existing and live inside an upload allowlist: the agent's workspace + `~/.pygmalion/data` by default, extendable via `AGENTPROTO_BROWSER_UPLOAD_ALLOW_DIRS` (a `:`-separated dir list). Outside the allowlist → typed refusal, the driver is never touched.
- **Several tabs in the agent's own window** — `browser_new_tab { sessionId, url? }` opens a FRESH tab (the same activate-anchor → `Target.createTarget` → `getWindowForTarget` flow as the first tab, never a reuse, never the user's windows), `browser_list_tabs { sessionId }` lists the agent-owned tabs (`{ targetId, url, windowId }[]`), and every existing browser tool already accepts those `tabId`s.

`ChromeLiveInstance` grew `uploadFileOwnedTarget` / `newTabOwnedTarget` / `listOwnedTabs`; `evalRaw` on `ChromeCdpDriver` became `protected` so the live driver can probe the file input first (`no <input type=file> matches selector …`).
