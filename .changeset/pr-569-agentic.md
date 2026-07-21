---
"agentproto-vscode": minor
---

Add `agentproto.configureSession` command for per-session configuration. Renders dynamic chip strip from daemon capabilities (model, effort, route, access, posture, context profile) as interactive quick pick. Live chips (model/effort/native posture) switch via daemon verbs; restart-only chips apply via `session_restart` with override. Includes proper model↔route trap detection, profile eligibility tracking, and advisory posture labeling (SPEC §6).
