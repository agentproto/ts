---
"@agentproto/runtime": minor
"agentproto-vscode": patch
---

A session parked on the daemon's `awaitingQuestion` is now answerable in one click from the VS Code session list and the transcript panel. The tree row and webview list lead with the question text ("Context is at 69%. Continue fresh to avoid losing continuity?" with its `continue-fresh` / `handoff:*` / `keep-going` options), the tooltip carries the full option list with the daemon-recommended one check-marked (NEW `SessionAwaitingQuestion.recommended`, set by the runtime's context-continuity ask to `continue-fresh`), and a new `agentproto.answerSessionQuestion` command quick-picks those options and sends the chosen one verbatim through the normal prompt path. A session flagged `awaitingInput` WITHOUT a question no longer alarms: it reads "idle, waiting for next prompt" with the calm quiet dot (tree icon `iconForSession`, webview list `idle-awaiting` row status, transcript tab `titleStatusState` refinement). The transcript pause card renders the question text, heuristic-source hint, and the same option buttons — each sending the exact option string via the normal composer send path.
