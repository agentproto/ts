---
"@agentproto/runtime": minor
---

Implement automatic parent attribution for spawned agents via attach policy layer, fixing the orphan-executor bug. Supervisors spawning executors without orchestrator setup now nest as children instead of appearing as depth-0 roots. Also adds session origin tracking and grouping for UI-friendly "claude-code vs vscode vs cron" views.

New features:
- `agent_start.attach` field: control spawn parent attachment (false=independent root, true=force attach, {parent}=explicit pin)
- `spawn.attach` daemon config: policy mode (always=default, on-request=explicit opt-in only)
- Session descriptor `origin` field: group roots by source (claude-code, vscode, cron, …)
- `groupRootsByOrigin()` function: bucket session tree by origin for group-based UX views
- `AGENTPROTO_SPAWN_ATTACH` env override for attach policy

All new fields are optional; backward compatible default "always" mode auto-attaches via trusted callerSessionId.
