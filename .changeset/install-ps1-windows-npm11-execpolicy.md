---
"@agentproto/cli": patch
---

fix(bootstrap): install.ps1 works on Windows 11 with npm 11 and a Restricted ExecutionPolicy — allow-lists node-pty (`--allow-scripts=node-pty`), always calls `agentproto.cmd` (never the blocked `.ps1` shim), and prints clear guidance when the effective policy is Restricted/AllSigned
