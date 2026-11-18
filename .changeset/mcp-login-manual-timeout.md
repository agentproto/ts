---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

`agentproto mcp login` gains `--timeout <duration>` (e.g. `30m`, `1800s`; 10s–2h, default 5m) and `--manual`/`--paste`, which also accepts the pasted callback URL on stdin alongside the loopback listener. `loginMcpOAuth` takes a `manualCallback` option and exports `parseAuthorizationCallback`; the pasted state is verified and code/state are never logged.
