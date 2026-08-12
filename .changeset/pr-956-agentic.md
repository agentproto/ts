---
"@agentproto/cli": minor
---

Add file upload endpoint (`/__agentproto/upload`) to `agentproto app serve`, enabling browser UIs to upload files to an `inbox/` directory. Exports new utility functions: `sanitizeUploadName()` for security-focused filename validation, `resolveInboxTarget()` for collision-resistant path resolution, and `UploadSizeTracker` class for enforcing 200 MB size limits.
