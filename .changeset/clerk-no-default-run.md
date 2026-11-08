---
"@agentproto/clerk": patch
---

The clerk's default `run` is now empty instead of `routine: "steward"`, a routine that does not exist. A clerk enabled with nothing to run does a clean no-op with one info line instead of a failing pass; an explicitly configured `run` is unchanged.
