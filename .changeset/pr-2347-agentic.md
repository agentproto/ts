---
"@agentproto/runtime": minor
---

Follow agent-caused AIP-45 `mode-changed` events in a session's `posture`, and record the caller's last posture as a `postureCeiling`: an agent move past the ceiling emits `session:harness-warning`, and a restart clamps back to the ceiling. The ceiling (and `postureSource`) is carried across both in-place revivals and new-id restarts when the caller did not set a new posture, and the in-place resume hook now starts the harness at the clamped posture.
