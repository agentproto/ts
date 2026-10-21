---
"@agentproto/runtime": minor
---

`message_send` / `message_reply` can now reach any session of the SAME workspace, even without a tree edge. Two permanent agents of one workspace (a marketing officer consulting a PM, a PM agent asking a supervisor session) were refused before because the messaging ACL only knows tree neighbours - parent, direct children, and, with `defaults.messaging.allowSiblings`, siblings. The new allowance is a new config key, `defaults.messaging.allowSameWorkspace` (default `true`), hot-applied like the other `defaults.messaging.*` knobs; set it to `false` to restore the tree-only rule. The message the recipient sees carries the new relation `peer`.

The allowance is narrow on purpose: it needs the same non-empty `workspaceSlug` on both descriptors (and the same workspace id, when a descriptor carries one). A different workspace, or a session with no workspace slug, is refused exactly as before, and the tree rules are untouched - a parent, a direct child, and (with `allowSiblings`) a sibling behave as they always did.
