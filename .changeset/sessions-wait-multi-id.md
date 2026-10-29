---
"@agentproto/cli": minor
---

`agentproto sessions wait` accepts several session ids and returns when all of them resolve, or on the first real match with `--any`. A single deadline is shared across the fan-out, `--any` only settles on exit 0 and remembers sibling failures, and multi-id `--json` emits one `{ results, mode }` document. Extra positionals in `--policy` mode now fail with a non-zero exit instead of being silently ignored.
