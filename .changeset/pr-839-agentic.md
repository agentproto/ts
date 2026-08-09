---
"@agentproto/driver-agent-cli": patch
---

Fix: Always suppress attribution (PR footer / commit trailer) in isolated agent-cli spawns, preventing settings leakage from operator's global configuration. Isolated processes now receive an explicit empty `attribution` configuration to close the ambient-leak surface.
