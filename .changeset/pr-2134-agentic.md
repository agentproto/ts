---
"@agentproto/workspace": patch
---

Accept the optional AIP-34 `presence` block in the WORKSPACE.md frontmatter schema so spec-valid manifests are not rejected with an unrecognized-key error. Mirrors the `work` inline/ref/file union and adds a parse test.
