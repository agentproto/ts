# @agentproto/knowledge-cascade

## 0.2.0

### Minor Changes

- 4210682: New library for composing file layers with override/extend/whiteout semantics. Provides `DiskFs` (node:fs-backed FsPort), `packFs` (read-only pack wrapper), and `mountCascade` (layer composition) for standalone apps and services to mount a global knowledge pack shadowed by per-scope overrides.

### Patch Changes

- Updated dependencies [f9e21fd]
  - @agentproto/corpus@0.7.1
