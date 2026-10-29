---
"@agentproto/runtime": major
---

Enforce AIP-34 node scope on the daemon's read paths (memory tools and digest, file tools, app data, brain query, imported-call gate). The scope is derived from the calling session's own ground (`desc.cwd`) and operator, never from server config. A request naming an unknown session is refused, a request with no caller id stays a host call, and a session grounded in no declared tree keeps today's behavior.

This supersedes the bump level of the PR's own `sealed-nodes-daemon-reads.md`: `registerBrainTools` is a public root export and its exported `RegisterBrainToolsOptions` now requires a `callerScope` field, which is an incompatible signature change for external callers. If `callerScope` is instead defaulted to `HOST_CALLER` (and the `CallerScope` type is exported), this can ship as `minor`.
