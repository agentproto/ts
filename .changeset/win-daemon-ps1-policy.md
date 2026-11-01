---
"@agentproto/cli": patch
---

Windows daemon: make the Task Scheduler path work under a Restricted or AllSigned PowerShell execution policy and non-ASCII user profiles. The `daemon install`, `start` and `restart` hints (including onboarding) cite the `agentproto.cmd` shim when the policy blocks the `.ps1` one, without double-rewriting an already shimmed command. The generated `agentproto-daemon.cmd` launcher switches cmd to UTF-8 (`chcp 65001`) before any non-ASCII path. Uninstall treats a missing task as already absent only when `schtasks /Query` reports that specific condition, so an access-denied query fails with the original error instead of claiming a successful uninstall.
