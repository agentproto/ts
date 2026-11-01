---
"@agentproto/cli": patch
---

Windows daemon: make the Task Scheduler path work under a Restricted/AllSigned PowerShell execution policy and non-ASCII user profiles. The generated `agentproto-daemon.cmd` launcher switches cmd to UTF-8 (`chcp 65001`) before any non-ASCII path, the install/start/restart hints become `agentproto.cmd ...` when the policy blocks the `.ps1` shim, and uninstall only treats a failed `schtasks /Query` as "already absent" when it reports the task is missing (normalized across English/French and OEM mojibake), so an access-denied query fails with the original error instead of claiming success.
