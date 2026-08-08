---
"@agentproto/cli": patch
---

Fix daemon adapter installs: strip the "install" verb before passing args to runInstall, and add --allow-unverified flag to allow TTY-less daemon/UI installs of catalog adapters.
