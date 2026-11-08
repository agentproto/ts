---
"@agentproto/adapter-browser-chrome": patch
"@agentproto/adapter-browser": patch
"@agentproto/cli": patch
---

chrome-live: the browser websocket gets a silent keep-alive ping (`heartbeatIntervalMs`, default 25s) so Chrome's idle reaper does not drop it; `ensure` merges the `agentproto browser install chrome-live` ledger as lowest-priority env; the empty `chrome-live-ws-url` step is optional in `browser start`; `browser status` probes the adapter's declared `healthPath` instead of a hardcoded `/health`.
