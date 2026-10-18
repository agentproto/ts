---
"@agentproto/adapter-browser-chrome": minor
"@agentproto/runtime": minor
---

`chrome-live` gains two agent-surface features, exposed as new MCP tools in `@agentproto/runtime`:

- **File upload onto a real `<input type=file>`** — `browser_upload_file { sessionId, selector, paths, tabId? }` attaches local files through CDP `DOM.querySelector` + `DOM.setFileInputFiles`. Every path must be absolute+existing and live inside an upload allowlist (the agent's workspace + `~/.pygmalion/data` by default, extendable via `AGENTPROTO_BROWSER_UPLOAD_ALLOW_DIRS`).
- **Several tabs in the agent's own window** — `browser_new_tab { sessionId, url? }` opens a FRESH tab, `browser_list_tabs { sessionId }` lists the agent-owned tabs, and every existing browser tool already accepts those `tabId`s.

`ChromeLiveInstance` grew `uploadFileOwnedTarget` / `newTabOwnedTarget` / `listOwnedTabs`; `evalRaw` on `ChromeCdpDriver` became `protected` so the live driver can probe the file input first.

Note: an equivalent changeset (`.changeset/chrome-live-upload-multitab.md`) is already present in this PR with the same package list and bumps.
