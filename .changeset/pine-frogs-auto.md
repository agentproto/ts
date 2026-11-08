---
"@agentproto/app": minor
"@agentproto/runtime": minor
---

An AIP-53 link-session token can read `GET /sessions/:id/capabilities` for its own session, next to the three existing read routes. Under a link token, `permissions_respond` is dispatched only when the permission `id` is pending for the linked session: an unknown id or one from another session is refused. `defineApp` now accepts an empty `ui.toolScope` entry only for the tools the daemon checks this way (`TOOL_SCOPE_OWNERSHIP_CHECKED_TOOLS`, `permissions_respond` today), and the daemon refuses an empty entry for any other tool under a link token.
