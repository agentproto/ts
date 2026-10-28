---
"@agentproto/runtime": minor
---

Add `defaults.messaging.peerBinding` ("slug" default, "verified"): verified binds no-tree-edge peers only when both cwds resolve to the same registered workspace, reports `peerVerified` on decisions, and logs a shadow `peer-unverified` warning where the two rules disagree.
