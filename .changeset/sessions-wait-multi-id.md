---
"@agentproto/cli": patch
---

`agentproto sessions wait` accepts several session ids and returns when all of them resolve, or the first with `--any`. Extra positionals in `--policy` mode now fail with a non-zero exit instead of being silently ignored.
