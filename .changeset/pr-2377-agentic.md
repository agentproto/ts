---
"@agentproto/runtime": minor
"agentproto-desktop": patch
"agentproto-vscode": patch
---

Add an optional `SessionAwaitingQuestion.kind` (`permission`, `context`, or `harness`) so every daemon writer of the awaiting question classifies what kind of wait it is; the operator `session_flag_status` override leaves it absent as unclassified.

The desktop and VS Code client types mirror the new optional field; those packages are private, so the patch bump only tracks the type-level mirror.
