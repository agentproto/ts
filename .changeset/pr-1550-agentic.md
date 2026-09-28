---
"agentproto-vscode": patch
---

fix(vscode): keep `@ast-grep/napi` external in the extension bundle so esbuild no longer attempts to inline its native `.node` binary; Mastra's AST edit tool is simply unavailable in the VS Code host when the module is absent.
