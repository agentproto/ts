---
"@agentproto/app": patch
---

Reject absolute and `..`-containing `cwd` values on an AIP-53 app `services[]` entry, so a service can only start inside its app directory. The vendored `specs/resources/aip-53/draft/APP.schema.json` services schema is resynced to canonical, and the now-obsolete `pending/services` draft schema is removed. This mirrors the changeset already present at `.changeset/app-services-cwd-relative.md`.
