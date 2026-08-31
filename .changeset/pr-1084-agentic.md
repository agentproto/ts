---
"@agentproto/driver-agent-cli": minor
"@agentproto/runtime": minor
---

Add support for tracking model switches sent as ordinary prompts. Introduces an optional `activeModel` field to `SessionDescriptor` that captures the model believed to be running after a live switch, distinct from `model` (the requested/spawn-time value). The daemon learns switches from two paths: (1) a successful `setModel` call (verified, mirrors `model`), or (2) a `/model <id>` command sent as a plain conversational prompt followed by an adapter acknowledgement (unverified, advisory only — for UI display, never billing). Exports `isModelSwitchAcknowledgement()` and `parseModelSwitchCommand()` from agent-cli for reuse across both paths. VS Code's composer chip now renders "requested → active" when they diverge.
