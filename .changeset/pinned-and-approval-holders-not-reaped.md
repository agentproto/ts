---
"@agentproto/runtime": patch
"@agentproto/skill-pack-agentproto": patch
---

The idle reaper never stops a pinned session (pinned now means never stopped, it was only a sort flag), nor a session that holds an approval (one it requested that is pending, or approved and not yet consumed). When such a session still exits, its AIP-59 sub-session revoke, which closes the Bureau tabs it owns, is deferred until the approval is consumed, denied or expired, so an approved card no longer turns into FORM_LOST. The approval-to-session link is the existing `requestedBy.sessionId`; no store change.
