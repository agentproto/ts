---
"@agentproto/corpus": patch
---

Fix citation parsing to safely ignore array indexing in code blocks and inline code; add support for anchor-prefixed chapters from `assembleChapters({ injectAnchors: true })`; improve post-check failure tracking with new `postCheckFailed` stats field.
