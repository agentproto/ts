---
"@agentproto/app-kit": minor
"@agentproto/runtime": minor
---
Apps can call each other. `requires.apps` entries may now be objects
(`{ id, version?, workflows? }`) next to bare ids, and `exposes.workflows`
declares which workflows an app lets other apps run. A new `app_call` MCP verb
runs an exposed workflow on behalf of an installed consumer app, checking the
declared dependency, the workflow allowlist, the provider's exposed workflows
and its installed version range, and returns the workflow's output with a
distinct error code per refusal. `app_apply` also refuses an app whose declared
dependency version range is not satisfied. The daemon is local-trust:
`callerAppId` is a declaration check, not an authentication boundary.
