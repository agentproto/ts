---
"@agentproto/runtime": minor
"@agentproto/plugin-local-browser": minor
"@agentproto/cli": minor
---

Per-session headless browser: `agent_start`/HTTP/CLI spawns accept `browser: "headless"` (off by default), mounting an isolated chrome-devtools-mcp stdio server with a per-session Chrome profile that is swept on session exit; `buildHeadlessBrowserMcpEntry` gains an optional `userDataDir`.
