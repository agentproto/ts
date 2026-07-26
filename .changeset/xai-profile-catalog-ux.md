---
"agentproto-vscode": patch
---

Auth Settings webview now distinguishes the curated model count from the total catalog-available count and the runnable count, and surfaces data-supported reasons (e.g. "curated out") when models are unavailable. Native `xai` and `xai-anthropic` profiles remain scoped to their own routes and do not cross-qualify.
