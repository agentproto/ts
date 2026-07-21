---
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Fix session display name precedence: derived titles now outrank spawn labels

Introduces a `renamedByUser` flag to distinguish user-renamed labels from spawner-supplied labels. This allows the derived title (first sentence of the first prompt) to outrank spawn labels in the display precedence, preventing slugs like "auto-title-precedence-fix" from shadowing useful titles. User-explicit renames still win.

Breaking compatibility: None. Sessions persisted before this change treat an absent `renamedByUser` flag on a labelled session as "user-renamed" to preserve prior edits; only new spawns stamp the flag explicitly.
