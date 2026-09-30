---
"@agentproto/cli": minor
---

`agentproto daemon install` now works on Windows: it registers a per-user
scheduled task (`schtasks /SC ONLOGON`) — no admin required — whose launcher
captures the same `node cli.mjs serve` argv snapshot as the macOS plist and
merges output into `~/.agentproto/daemon.log`; plus `start`/`restart`/`stop`
map to `schtasks /Run` / `/End` and Linux keeps the explicit "not yet
supported" refusal. The onboarding daemon step offers the scheduled-task
install on win32 as the default action (manual `serve` remains the Linux
fallback). Wording pass: the auth step and preflight Node warnings say what
they mean for first-time users, and adapter-skip warnings name the cause and
the fix.
