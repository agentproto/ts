---
"@agentproto/runtime": patch
---

MCP human gate follow-ups. The approval console URL filter now splits each query key into words (on `_`, `-`, `.` and camelCase) instead of matching a substring, so a key like `designer` is no longer refused while `token`, `api_key`, `session-id`, `accessToken`, `apikey` or `password` still are. The new internal `checkApprovalUrl` says why a base is refused (`buildApprovalUrl` keeps its signature), and the daemon logs one line with the reason, never the URL, when a configured `approvals.uiBaseUrl` is refused for a client that can receive a url elicitation. `resolveHumanGateSurfaces` only returns `approvalsUiBaseUrl` while the approvals surface is on. The MRTR state store refuses a signed token whose kind is unknown: the internal `MrtrVerifyFailureReason` union gains `"unsupported_kind"` (not on a published export path). The `mcp.humanGate` help now names its four surfaces.
