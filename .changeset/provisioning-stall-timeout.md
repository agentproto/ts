---
"@agentproto/worktree": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Bound worktree provisioning with a stall timeout (default 2 min without setup output) and a hard cap (default 30 min). A tripped bound kills the setup process tree and fails the session with the phase, elapsed time and last output lines. Configurable per spawn (`worktree.stallTimeoutMs` / `maxMs`), via `worktrees.provisionStallTimeoutMs` / `provisionMaxMs` or env. The setup hook output now streams into the starting session's output and provisioning start, phases and failure are logged to daemon.log.
