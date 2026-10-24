---
"@agentproto/doctype": minor
"@agentproto/define-doctype": minor
---

Rename the doctype meta-factory to its AIP-70 canonical name `@agentproto/doctype`, moving the implementation unchanged. `@agentproto/define-doctype` is kept as a deprecated shim that re-exports the new package so existing importers keep working; the workspace STATUS/spec-reference classification and tests are updated for both names.
