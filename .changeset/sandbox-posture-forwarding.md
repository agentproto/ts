---
"@agentproto/runtime": patch
"@agentproto/harness": patch
"@agentproto/cli": patch
---

Carry posture through sandbox sessions and label spawn-enforced postures in
pickers. A sandbox (box-proxied) spawn or restart now forwards `posture` to the
box's own `agent_start`, so the box daemon applies it like a local spawn
(native mode, isolated spawn config, or the advisory preamble). Before, the
host dropped it outright. The box's `agent_start` response carries
`spawnEnforcedPostures`, and the host proxy surfaces it, so a box session reports
`spawn-config` instead of advisory. An older box that reports nothing stays
advisory. `GET /adapters` entries carry `spawnEnforcedPostures` (claude-code,
opencode). The VS Code posture picker and Configuration Lab label those postures
"(enforced)", applied on restart, instead of "(advisory)".
