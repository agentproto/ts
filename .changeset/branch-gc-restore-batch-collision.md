---
"@agentproto/worktree": patch
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

`branch gc restore`: entries of one restore log that map to the same target (with `--local-only`, a remote and a local entry of the same name) are resolved before anything runs, from content rather than log order, so a dry run reports exactly what the real run does. The same sha twice is restored once (the next is `already-present`); when one sha descends from the other, the descendant is restored and the ancestor gets the new `contained` result; diverged shas are both `refused-conflict`, naming each other, until `--sha` picks one. The CLI summary counts `contained`.
