---
"@agentproto/runtime": patch
---

fix(agent_start): a `cwd` on a `sandbox` + `workspaceSlug` spawn no longer cancels the in-box workspace setup. The workspace remote is always cloned into the box with the git token and delivery branch, and `cwd` is read as a path inside the box (relative to the checkout, or absolute under the box home); a host-only path or a path outside the box home is ignored with a warning. A sandbox spawn with a `cwd` but no workspace remote now returns an advisory warning that the box has no repo, git token or delivery branch.
