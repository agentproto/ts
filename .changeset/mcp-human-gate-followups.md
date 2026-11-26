---
"@agentproto/runtime": patch
---

MCP human gate follow-ups. The approval console URL filter now splits each query key into words (on `_`, `-`, `.` and camelCase) instead of matching a substring, so a key like `designer` is no longer refused while `token`, `api_key`, `session-id`, `accessToken`, `apikey` or `password` still are. The new `checkApprovalUrl` says why a base is refused (`buildApprovalUrl` keeps its signature), and the daemon logs one line with the reason, never the URL, when a configured `approvals.uiBaseUrl` is refused. `resolveHumanGateSurfaces` only returns `approvalsUiBaseUrl` while the approvals surface is on. The MRTR state store refuses a signed token whose kind is unknown: `MrtrVerifyFailureReason` gains `"unsupported_kind"` (exported type, exhaustive switches over it need the new case). The `mcp.humanGate` help now names its four surfaces.
