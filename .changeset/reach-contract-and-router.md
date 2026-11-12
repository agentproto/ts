---
"@agentproto/reach": minor
"@agentproto/runtime": minor
---

New package `@agentproto/reach`, the REACH contract (`reach/v1`) with zero runtime dependency. It has the `ReachMessage`, `ReachReceipt`, `ReachAdapter`, `ReachCapabilities`, `ReachRouteEntry` and `ReachAnswer` types, `reachContentFromPreview` (approval preview to message content), a strict `parseReachReceipt`, and `runReachConformance`, a check a webhook receiver can run in its own tests.

The daemon gets an opt-in REACH router. With `reach.routes.owner` set, each `approval:requested` becomes one message that goes to the route's adapters in order (`webhook`: a signed POST answered by a receipt; `telegram`: the existing approval card bridge) until one answers `delivered`, `deferred` or `deduped`. Every attempt is appended to the approval's `reach.json`. If no adapter acknowledges, the daemon emits `reach:undelivered` and logs `reach: undelivered <id>`. A watchdog sends any pending approval that has no acknowledgement after 60 s through the last `telegram` entry and logs `reach: MISSING <id>`. A decided or expired approval closes the webhook that acknowledged it. `POST /approvals` and `approval_request` accept `reach: false | { urgency }`, and the MCP tool does not accept `urgency: "now"`. `config_get` never shows the webhook `secret`. Without `reach` config the behaviour is unchanged.
