---
"@agentproto/cli": minor
---

`agentproto sessions wait` now accepts several session ids and fans out concurrently, returning when all of them resolve by default or when the first one matches with `--any` (aborting the remaining waits). The `--timeout` budget is shared across the fan-out, and extra positionals in `--policy` mode now fail with a non-zero exit instead of being silently ignored.
