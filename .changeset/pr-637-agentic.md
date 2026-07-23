---
"agentproto-vscode": minor
---

Add resume-in-place affordance for daemon-restart recovery: new `agentproto.resumeSession` command that sends a plain prompt to the same session id (distinct from restart which mints a new id). Includes new `SessionDescriptor` fields `endedReason` and `interrupted` to distinguish resumable ghosts from ordinary terminal rows, with UI surfaces for interrupted-turn notices.
