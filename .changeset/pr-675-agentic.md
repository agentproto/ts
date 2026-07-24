---
"agentproto-vscode": patch
---

Refactor spawn picker to harness-first drill-down with quick-entry support. Fixes combinatorial picker explosion by collapsing product×route combinations into one row per product on its best route, then narrowing model selection by chosen harness. Quick-entry picker shows saved favorites and recent spawn combos for power users; falls back to harness drill-down for new users. Includes manifest fallback for old daemons without `/catalog/models`.
