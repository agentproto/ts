---
"@agentproto/runtime": patch
---

Harden command sandbox security: implement fail-closed validation when a confinement mode is explicitly configured but the platform lacks the required backend (sandbox-exec on macOS or bwrap on Linux), and add loud per-call warnings when commands run unconfined. Add `AGENTPROTO_COMMAND_SANDBOX_MODE` environment variable to override workspace config without editing tracked files.
