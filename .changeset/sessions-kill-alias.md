---
"@agentproto/cli": patch
---

`agentproto sessions kill <id>` is now an alias of `sessions stop`. Any other unknown `sessions` subcommand now exits with code 2 and a clear message on stderr (with a "did you mean" hint when one is near) instead of a `util.parseArgs` stack trace.
