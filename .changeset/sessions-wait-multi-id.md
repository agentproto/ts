---
"@agentproto/cli": minor
---

`agentproto sessions wait` accepts several session ids and returns when all of them resolve, or on the first match with `--any`. Extra positionals in `--policy` mode now fail with a non-zero exit instead of being silently ignored, and `--json` is rejected with multiple ids rather than emitting concatenated documents.
