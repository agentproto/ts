---
"@agentproto/adapter-browser-chrome": patch
"@agentproto/adapter-browser": patch
"@agentproto/cli": patch
---

chrome-live: the browser websocket gets a silent keep-alive ping (`heartbeatIntervalMs`, default 25s) so Chrome's idle reaper does not drop it; `ensure` merges the `agentproto browser install chrome-live` ledger as lowest-priority env, ignoring a ledger value that only restates the step's declared default (an accepted default is also no longer persisted) so a default port never pins an endpoint and flips a bare start to attach-first; the empty `chrome-live-ws-url` step is optional in `browser start`; `browser status` probes the adapter's declared `healthPath` instead of a hardcoded `/health`.
