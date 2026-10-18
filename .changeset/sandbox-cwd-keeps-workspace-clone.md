---
"@agentproto/runtime": patch
---

fix(agent_start): a `cwd` no longer cancels the sandbox workspace setup. With `sandbox` + `workspaceSlug`, the git remote is always cloned into the box with the git token and delivery branch, and `cwd` is read as a path inside the box (relative to the checkout, or absolute under the box home); a host path is ignored with a warning. A sandbox spawn with a `cwd` but no workspace remote now returns a warning that the box has no repo, git token or delivery branch.
