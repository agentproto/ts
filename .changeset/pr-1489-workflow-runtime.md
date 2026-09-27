---
"@agentproto/workflow-runtime": patch
---

Fix `kind:"artifact"` steps and `outputsFiles` storing a run artifact as `artifacts/<key>` with no extension. The on-disk name is now the declared file's own basename (`outputsFiles.pdf: {path: transcript.pdf}` now lands at `artifacts/transcript.pdf`), with a colliding basename between two keys deterministically disambiguated by prefixing the second with its own key instead of silently overwriting the first.
