---
"@agentproto/workflow-runtime": patch
---

Fix a regression where AIP-58 P4's per-run workspace broke cacheable `tool`/`agent` step replay: the resolved-input hash now ignores the run's own workspace path (a fresh absolute directory every run), and a cache hit relocates any workspace-relative file the entry recorded into the current run's own workspace.
