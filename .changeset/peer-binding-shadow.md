---
"@agentproto/runtime": minor
---

Add `defaults.messaging.peerBinding` ("slug" default, "verified"): the verified rule makes two sessions peers only when both cwds resolve to the same registered workspace.
Default behaviour is unchanged; decisions now report `peerVerified` and the daemon logs a `peer-unverified` warning where the two rules disagree.
