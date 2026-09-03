---
"@agentproto/app-kit": major
"@agentproto/cli": patch
---

app-kit: Remove typed support for the book/library contract (AppLibraryDefinition, AppLibraryBook). The library.books convention now lives as untyped APP.md frontmatter — apps that need the book contract hand-write it directly without type validation.

cli: Update comments to reflect that app-kit has no typed support for the library.books convention; CLI continues to read it directly from frontmatter.
