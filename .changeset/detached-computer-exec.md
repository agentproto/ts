---
"@agentproto/sandbox-computer": patch
---

Long in-box commands now run through a detached exec transport: the command is written to a script, started with `setsid nohup`, and polled with short execs instead of one synchronous controller request. A command that outlives Cloudflare's 100 second request cut no longer fails with a 524. The boot CLI install, configured setup commands, and any `exec` whose effective timeout exceeds 90 seconds use it — an omitted timeout defaults to 120 seconds, so it detaches too; a short command with a short explicit timeout keeps the single request path.
