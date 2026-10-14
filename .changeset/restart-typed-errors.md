---
"@agentproto/runtime": patch
"@agentproto/apps": patch
"@agentproto/cli": patch
---

Session restart failures are now typed: a restart that cannot complete throws `SessionRestartError`, carrying a stable `code` (`sandbox_gone`, `sandbox_unreachable`, `sandbox_provider_missing`, `sandbox_box_start_failed`, `no_workspace`, `no_workspace_remote`, `no_known_branch`, `adapter_not_found`, `unsupported_strategy`, `retired`, `override_invalid`), a human `reason`, and an optional `action` hint (`fix-config` / `spawn-fresh` / `spawn-on-branch`) that a client can turn into a button. Transports surface these as a nested `{ error: { code, reason, action?, message }, message }` payload, so the HTTP route, the `session_restart` MCP verb and the CLI all report *why* a restart failed and what to do next instead of leaking provider-internal strings. The session-chat bridge rejects a typed `session_restart` failure with its `reason` sentence rather than the raw payload, and `agentproto sessions restart` prints the `reason` first with the technical detail underneath.
