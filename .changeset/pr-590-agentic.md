---
"@agentproto/cli": patch
---

Fix: `agentproto sessions start` now defaults working directory to the shell's current directory instead of silently using the daemon's active workspace. Aligns with standard CLI behavior (like git/npm). An explicit `--workspace` still lets the daemon resolve its own cwd; `--cwd` takes precedence over shell default.
