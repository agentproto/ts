---
agentproto-vscode: patch
---

Enhanced file link resolution with robust fallback strategies: sanitization of decorated paths, multi-stage resolution (direct → sanitized → suffix matching → basename), and QuickPick for multiple matches. Adds graceful binary file handling via vscode.open fallback. Fixes working row visibility in book view to avoid duplication with live chapter status. Improves empty conversation display with session identity hero showing harness, model, mode, and wallet. Includes post-layout re-measure for message clamping to avoid spurious expanders on first paint.
