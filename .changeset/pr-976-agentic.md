---
"agentproto-vscode": patch
---

Fix: composer stuck on "Sending…" after mid-turn send — clear `isSending` on `queued` ack (regression from #967). UX: "Interrupt & send" now shows whenever the agent is busy and implements stop-and-go behavior (interrupts current turn and sends typed text, or forces the front of the queue when empty). Each queued row gains a per-item "send now" button.
