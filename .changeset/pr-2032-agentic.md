---
"agentproto-vscode": patch
---

Fix cross-route model switches in the VS Code extension. `model` and `access` are independent restart axes, but the daemon validates the pair, so moving a session to a model on another route (e.g. `opencode/x` → `opencode-go/x`) with the old auth profile carried forward failed with a 400. The restart flows now resolve the target route's eligible profiles and, when the attached wallet is not among them, attach the first eligible profile in the same `session_restart` override (or surface a clear error when the target route has no eligible profile). The daemon's eligibility rule is unchanged.
