---
"@agentproto/driver-agent-cli": patch
"@agentproto/runtime": patch
---

Report how a posture is actually enforced instead of calling every
non-native posture advisory. The driver now exposes `spawnEnforcedPostures`
(exported helper, and stamped on each started session) — the canonical
postures an adapter enforces through its isolated spawn config: claude-code's
`permissions.defaultMode` and opencode's per-session `permission` block. The
runtime classifies a posture with the new pure `postureEnforcement` helper as
`native`, `spawn-config`, `prompt-advisory`, `none` or `unavailable`, and
surfaces it additively: a read-time `spawnEnforcedPostures` echo on the session
descriptor (never persisted), `postureEnforcement` and
`canonicalPostureEnforcement` on `session_capabilities` /
`GET /sessions/:id/capabilities`, an `enforcement` field on `setPosture` /
`agent_set_posture` results (so a `requires-restart` for opencode `bypass` says
the restart lands a real boundary), and `spawn-config` in a read-only decision
escalation's `toolControls.enforced.posture` where it used to say
`prompt-advisory`.
