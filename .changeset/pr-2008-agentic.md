---
"@agentproto/adapter-browser-chrome": minor
"@agentproto/adapter-browser": minor
---

chrome-live now falls back to auto-launching a dedicated headful Chrome when the remote-debugging toggle is not attachable on the default endpoint (9222). The launched browser runs on a free port with its own persisted user-data-dir (`~/.agentproto/browser/chrome/live`, override `CHROME_LIVE_LAUNCH_DATA_DIR`), requires no consent click, and is tracked so that `stop()` kills only that pid — attach-to-9222 stays the preferred path and the user's own Chrome is never signalled. An explicitly pinned endpoint (launch `wsUrl`/`port`, provider config, or `CHROME_LIVE_*` env) disables the fallback.
