---
"@agentproto/cli": patch
---

Windows daemon: make the Task Scheduler path work when PowerShell blocks script shims and the user profile contains non-ASCII characters. The `daemon start`/`restart` hint now cites `agentproto.cmd daemon install` under a Restricted or AllSigned execution policy (onboarding uses the same hint), the generated `agentproto-daemon.cmd` launcher switches cmd to UTF-8 (`chcp 65001`) before any non-ASCII path, and uninstall treats a missing task as already absent only when `schtasks /Query` reports that specific condition, so an access-denied query fails with the original error instead of claiming a successful uninstall.
