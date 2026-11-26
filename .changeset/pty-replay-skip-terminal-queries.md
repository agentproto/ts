---
"@agentproto/runtime": patch
---

Stop replaying terminal queries to a terminal that attaches late to a PTY session. The recent-output replay no longer includes device-attribute, terminal-identity, keyboard-flag, status, mode, window-size, colour and graphics-support requests, so the attaching terminal no longer answers them after the child stopped waiting (the late reply used to land in the child's input).
