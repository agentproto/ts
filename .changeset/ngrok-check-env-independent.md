---
"@agentproto/runtime": patch
---

Make the ngrok provider check() test environment-independent (inject probeBinary) so it no longer depends on the ngrok binary being installed — fixes CI on main.
