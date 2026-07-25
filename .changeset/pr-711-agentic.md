---
"@agentproto/cli": patch
---

Refactor GitHub pack source from codeload tarball (source code) to GitHub Release asset (built pack). Changes fetch grammar from `github:owner/repo#ref` to `github:owner/repo[@version]`, targeting per-package release artifacts instead of arbitrary repo commits. Aligns with CI publishing strategy.
