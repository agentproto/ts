---
"@agentproto/runtime": patch
"agentproto-vscode": patch
---

Add in-band adapter turn-error tracking and refactor session status precedence. Introduces `lastTurnErroredAt` field to distinguish adapter-reported failures (status stays "running") from thrown/rejected streams (status→"error"). Reorders status dot precedence to awaiting > stalled > busy and separates healthy parked-bg sessions from genuinely stuck ones in the status bar.
