---
"@agentproto/runtime": patch
---

Fix terminal_start / POST /sessions/terminal with an access profile: the argv `--model` is now checked against the profile allowlist instead of the adapter default model.
