---
"@agentproto/browser-process": minor
"@agentproto/adapter-browser": minor
"@agentproto/runtime": minor
---

start_browser no longer blocks the MCP request during a cold start — heavy services (chromium/bureau) register immediately as `starting` and converge to healthy in the background; opt-in via BrowserProcessSpec.initialWaitMs, default behavior unchanged.
