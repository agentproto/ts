---
"@agentproto/runtime": patch
---

message_send `label:<label>`: document (tool description and `no_live_session_for_label` error) that it matches only the immutable operator label, stamped on operator-started sessions; children spawned by a session must be addressed by id. Behaviour unchanged (by design: a session-settable label would let a session claim another's address).
