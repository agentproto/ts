---
"@agentproto/knowledge-cascade": minor
---

New library for composing file layers with override/extend/whiteout semantics. Provides `DiskFs` (node:fs-backed FsPort), `packFs` (read-only pack wrapper), and `mountCascade` (layer composition) for standalone apps and services to mount a global knowledge pack shadowed by per-scope overrides.
