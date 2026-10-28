---
"@agentproto/app": patch
---

Reject an absolute or `..`-containing `cwd` on an app `services[]` entry, matching AIP-53 (the service must start inside its app directory). Both were previously accepted: `/abs/dir`, `../x` and `a/../b` now fail validation with an error naming the service and the `cwd` field. `.` and plain relative paths such as `sub/dir` are unchanged. Also syncs the vendored AIP-53 `APP.schema.json` services schema to canonical.
