---
"@agentproto/runtime": minor
---

Add `defaults.drive.allowSameWorkspace` (default OFF) plus the matching `driveAllowSameWorkspace` runtime option / `PermissionContext.drive` field. When enabled, rule 5 of `checkSessionOwnerGate` lets the drive tools (`agent_prompt`, `agent_interrupt`, `agent_kill`, `session_restart`, `session_continue_fresh`) reach any session in the SAME workspace without a spawn-tree edge or an `allowPromptFrom` grant, for operators running a flat roster of permanent sibling agents. Off by default because a drive grant can also restart or kill the target.
