---
"@agentproto/usage-presets": major
"@agentproto/cli": minor
---

feat(usage-presets): usage-named spawn presets (pr-fix/explore/implement/review/deploy)

The caller names the WORK; the preset fixes the model, auth profile, posture, execution place (local vs OVH sandbox) and never which model to use / which place to use. Enforces the sensitive never-free rule + the 2-free-agents-local cap with sandbox redirect, and wires the new agentproto usage plan entrypoint into @agentproto/cli.
