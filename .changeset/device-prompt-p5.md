---
"@agentproto/runtime": patch
---

Device-sandbox spawn prompt composition fix + regression coverage (BOOTSTRAP P5 / agentproto/ts #1637)

`agent_start({ sandbox: "device:<fp>" })` leaked the controller's own AGENTS.md contract into the remote prompt: `spawnAgentSession` resolved AGENTS.md at the CONTROLLER's cwd and composed it into `effectivePrompt` before `bootSandboxAgentSession` swapped in the remote `booted.cwd`; the field-verified result read a Mac `/Volumes/...` pointer as `C:\Volumes\...` on a Windows host (File not found).

Fix: for a device-sandboxed spawn the controller skips workspace-contract resolution entirely — AGENTS.md, the same-class controller RULES.md, and the pointer read-grant never compose. The composed initial prompt carries only transportable text (role preamble, promptAppend, lineage line, caller's ask) plus a path-free device contract line naming the target device; the TARGET daemon resolves its own contract (its first prompt arrives via `agent_prompt`, which never re-runs composition — so no double preamble). Descriptor stamps `agentsMdMode: "absent"` with no controller path. Local (non-device) spawn behavior is unchanged.
