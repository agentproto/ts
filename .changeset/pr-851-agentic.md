---
"agentproto-vscode": patch
---

Refactor the "show archived" toggle to switch between mutually exclusive views (archived-only vs. active-only) instead of merging archived rows with active rows. Updates UI labels and aria-labels to reflect the new semantics, and adds empty-state messaging that adapts to the current view mode.
