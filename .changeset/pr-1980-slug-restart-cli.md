---
"@agentproto/cli": patch
---

Preserve a session's addressable `slug` across `agentproto sessions restart`: the CLI restart body now forwards `slug ?? name` (a post-slug row never writes `name`, so forwarding only `name` silently lost the `--name <handle>`), matching the runtime's `session_restart` pty branch.
