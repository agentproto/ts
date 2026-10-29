---
"@agentproto/runtime": minor
---

`DAEMON_TOOL_NAMES` is now emitted as an `as const` tuple and typed as `readonly DaemonToolName[]`, and the new `DaemonToolName` union is exported from the `./daemon-tool-names` subpath. A mismatched tool name in a typed registry list is now a typecheck error. Note this also narrows the public `DAEMON_TOOL_NAMES` type, so external callers that use `.includes()` with a plain `string` will need a type guard.
