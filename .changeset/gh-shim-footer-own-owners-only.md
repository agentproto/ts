---
"@agentproto/runtime": patch
---

The `gh` provenance shim no longer writes its footer (host, local path, session id) on a repository outside your own owners. A new `defaults.prProvenance.footer.ownerOrgs` list names the GitHub users or orgs whose repos may carry the footer; any other repo gets none on `gh pr create`, and `gh pr edit` never puts one back. The list defaults to empty, so set it to keep the footer on your own repos.
