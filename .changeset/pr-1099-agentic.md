---
"agentproto-vscode": patch
---

Fix @types/vscode version mismatch by pinning to engines.vscode floor (1.90.0). The automated dependency update had bumped the type package to ^1.134.0, which exceeded the minimum supported VSCode version and broke the package-and-publish CI gate. Since the extension code doesn't use any VSCode APIs newer than 1.90, pinning to the exact floor version maintains compatibility with all declared engines while resolving the mismatch.
