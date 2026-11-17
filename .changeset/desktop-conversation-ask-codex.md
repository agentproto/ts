---
"@agentproto/runtime": minor
---

`desktop_conversation_ask` now also asks Codex Desktop threads (`app: "codex"`): the thread is registered as a `codex:<id>` external row and the message goes through `message_send`'s path. A turn only starts through the opt-in Desktop wake (`daemon.codexDesktopWakeThreadIds`, `next-turn` urgency); the result carries `desktopWake` and a note saying why nothing woke otherwise. The answer is read from the thread's rollout.
