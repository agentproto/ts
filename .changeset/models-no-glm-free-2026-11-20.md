---
"@agentproto/runtime": patch
"@agentproto/usage-presets": patch
---

Replace the retired opencode/glm-5.3-flash-free with opencode-go/glm-5.3-flash in the usage presets and the default rotation.

Behaviour note: the `explore` and `implement` presets now resolve to the free deepseek model (local, with sandbox overflow); the glm 5.3 flash model on the Go subscription (not free, no per-IP limit) serves `pr-fix` and `review` in the sandbox. No preset spends more than before except where the retired free glm sat.
