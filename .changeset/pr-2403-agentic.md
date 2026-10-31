---
"@agentproto/runtime": patch
---

Never resume a provider-box session in place on the host: a box session's `cwd` only exists inside the box, so the lazy resume-on-prompt path now fails loud and directs callers to `session_restart` instead of spawning the adapter against a nonexistent host directory.
