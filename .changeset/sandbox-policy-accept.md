---
"@agentproto/sandbox": minor
---

Accept AIP-38 `policy` blocks in SANDBOX frontmatter schemas: the strict
`z.object` now declares the top-level `policy` key that the vendored JSON
draft has always advertised, so manifests carrying a policy block no longer
fail validation as an unknown key. Note: the block's shape is not yet
validated — the scaffolder emits `z.any()` for it until local `$ref`
resolution is implemented; accepting the key is the change.
