---
"@agentproto/driver": patch
"@agentproto/driver-cli": patch
"@agentproto/runtime": patch
---

`app_tool_call` (and `POST /apps/:appId/tool-call`) now hands an installed app's registered `dataDir` to its bundled CLI drivers as `AGENTPROTO_APP_DATA_DIR`, so a tool no longer falls back to `<app root>/data` when the app is installed from a worktree or another directory. The entry reaches the subprocess only if the driver lists the name in `sandbox.env.pass`, and it wins over the daemon's own variable. `runTool` gains an optional non-secret `hostEnv` (never a `${secrets.*}` source); no allowlist, approval tool or other environment changes.
