---
"agentproto-vscode": patch
---

Adapt DaemonClient to daemon 0.20+ compact-by-default projections: request `{ full: true }` for adapter_list/app_list/catalog_models and renest flat catalog rows into the legacy nested shape via a total client-side compat shim.
