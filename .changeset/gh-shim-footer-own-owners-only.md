---
"@agentproto/runtime": patch
---

The `gh` provenance shim no longer writes its footer (host, local path, session id) on a repository outside your own owners. A new `defaults.prProvenance.footer.ownerOrgs` list names the GitHub users or orgs whose repos may carry the footer; any other repo gets none on `gh pr create`, and `gh pr edit` never puts one back. The list defaults to empty, so set it to keep the footer on your own repos.

This only covers the `gh` shim. The daemon's own stamping lanes (`command_execute`, the reconciler, `pr_open`) are unchanged and still follow `skipRepos`. Owner matching ignores the forge host. Footers turn off for existing users of `provenance.wrapGh` until the list is set.
