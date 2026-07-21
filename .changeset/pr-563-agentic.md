---
"@agentproto/runtime": minor
---

Add trusted `parentSessionId` lineage hint (WP-R1) and `session:spawned` event (WP-R3) to enable agent-to-agent spawn attribution and real-time tree updates. The scoped orchestrator gateway's token always wins over hints, maintaining unspoofable parent derivation for nested spawns while filling the depth-0-orphan gap for root-path spawns.
