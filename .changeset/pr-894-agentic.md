---
"@agentproto/cli": patch
"@agentproto/driver-agent-cli": patch
---

Fix unhandled ChildProcess 'error' events that crash the daemon on spawn failures (e.g., bad binary, missing PATH entry). Resolve "node" binary to process.execPath to sidestep PATH lookup issues in minimal launchd environments. Convert spawn errors to rejected promises instead of unhandled exceptions.
