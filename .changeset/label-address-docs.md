---
"@agentproto/runtime": patch
---

message_send `label:<label>`: document (tool description and `no_live_session_for_label` error) that it matches only the immutable operator label, auto-stamped on operator-started sessions; a supervisor can stamp one on a child it owns with `agent_set_operator_label`, otherwise address by id. Behaviour unchanged.
