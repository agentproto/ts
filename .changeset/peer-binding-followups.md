---
"@agentproto/runtime": patch
---

Peer binding follow-ups: the `peer-unverified` shadow warning is written once per sender/recipient pair instead of on every message, `permissions_explain` is pinned to agree with `decide()` under `defaults.messaging.peerBinding`, and the config help states that `verified` can also link pairs whose recorded slugs differ.
