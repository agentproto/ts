---
"agentproto-vscode": minor
---

Add session isolation tracking and "Copy Session ID" command to VS Code extension. Sessions tree now displays worktree vs. in-place context with branch glyph (⑂), replacing redundant workspace names. New optional `worktreePath` and `worktreeId` fields on SessionDescriptor mirror the runtime's session metadata. New exported functions `worktreeName()` and `isolationLabelFor()` enable platform-agnostic worktree identification.
