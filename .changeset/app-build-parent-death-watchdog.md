---
"@agentproto/cli": patch
---

`agentproto app build`: a parent-death watchdog now tears the detached build process group down when the CLI (or a test runner hosting it) is SIGKILLed or crashes, so the build tree is never reparented to init and left running.
