---
"@agentproto/cli": patch
---

`agentproto app build` no longer leaves an orphaned build tree behind. The ui project's `<pm> run build` now runs in its own process group, and the whole group is killed on abort, timeout, a fatal signal to the CLI (SIGINT/SIGTERM/SIGHUP), or the CLI exiting. `runAppBuild` accepts an optional `{ signal, timeoutMs }` for callers; the CLI behavior and output are otherwise unchanged.
