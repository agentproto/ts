---
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Surfaces a session's daemon-reported `awaitingQuestion` as answerable UI. The runtime adds an optional `SessionAwaitingQuestion.recommended` field (set by the context-continuity ask to `continue-fresh`) so clients can mark the daemon's own recommendation, and the VS Code extension gains a new `agentproto.answerSessionQuestion` command that quick-picks the enumerated options and sends the chosen one verbatim through the normal prompt path. Tree rows, tooltips, webview rows, and the transcript pause card lead with the question text and its options, while an `awaitingInput` session without a question now reads as the calm `idle-awaiting` / "idle, waiting for next prompt" parked state.
