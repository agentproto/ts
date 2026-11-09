---
"@agentproto/runtime": patch
---

A link-session token carrying a `browserSessionId` claim can read the screencast routes (`/sessions/:id/screencast`, `.jpg`, `.mjpg`, GET only) of that browser session, which is the id the browser tools address and differs from the agent session id. The claim unlocks nothing else, and the tunnel gate and the sessions-token skip share one predicate.
