---
"@agentproto/runtime": minor
---

AIP-58 §2 run liveness: workflow runs interrupted by a daemon restart now fail with `host-interrupted`, and a periodic sweep fails runs whose owner lease expired with `orphaned`. App runs now report `succeeded`/`failed`/`cancelled` instead of `ended`/`stopped`, zombie app runs are swept to `failed` (`orphaned`), and `app_status` is compact by default (`full: true` for everything). `workflow_status` now fails only the step that actually failed (F29), caps errors in compact output (F30), lists branch-arm steps only once they run and in execution order (F31), and shows a running agent step's `sessionId` as soon as its session spawns (F34).
