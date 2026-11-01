---
"@agentproto/cli": patch
---

Windows daemon: make the Task Scheduler path work under a Restricted/AllSigned PowerShell execution policy and non-ASCII user profiles. The generated `agentproto-daemon.cmd` launcher now switches cmd to UTF-8 (`chcp 65001`) before any non-ASCII path, the install hint becomes `agentproto.cmd daemon install` when the policy blocks the `.ps1` shim, and uninstall decides "already absent" from `schtasks /Query`'s exit code instead of localized OEM-codepage error text.
