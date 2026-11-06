---
"@agentproto/runtime": patch
---

Honor `defaults.prProvenance.footer.skipRepos` in every provenance lane
(command_execute, pr_open and the gh PATH shim, not just the reconciler) and
compare repo names case-insensitively.
