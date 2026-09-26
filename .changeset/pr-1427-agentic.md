---
"@agentproto/acp": minor
---

Add ACP steering support to the client: `_session/steering` extension detection from `InitializeResponse._meta.steering.supported`, new `initMeta`/`steeringSupported` surfaces, and a non-throwing `AcpClientSession.steer()` gated to host-initiated turns.

---
"@agentproto/driver-agent-cli": minor
---

Expose optional `steer`/`steeringSupported` on `AgentCliClient` and `AgentCliRuntimeSession` (ACP arm passthrough) and export the `SteerOutcome` type.

---
"@agentproto/runtime": minor
---

Add `AgentSessionLike.steer`/`steeringSupported` and a `capabilities.steering` stamp on `SessionDescriptor`, surfaced in `session_list` compact rows.
