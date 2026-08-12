---
"@agentproto/cli": patch
---

Fix semantic accuracy of generic ACP agent status: report installed agents as 'ready' (bin on PATH, no setup/auth pending) instead of 'available' (which implies pending setup/auth). Eliminates UX bug where VS Code offered "Install" forever on already-installed CLIs.
