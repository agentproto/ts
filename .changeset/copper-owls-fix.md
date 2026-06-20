---
"@agentproto/corpus": patch
---

Fix dead code in synthesize.ts — `body.trim()` made `startsWith("\n")` unreachable; always prepend newline for gray-matter frontmatter separator.
