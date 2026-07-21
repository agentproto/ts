---
agentproto-vscode: patch
---

Unblock agent-cli→terminal harness switch via recoverable resume id fallback. Live claude-code sessions can now switch to terminal using the daemon's fs-based resume recovery mechanism, even before graceful-exit metadata is available. Also remove hermes from supported adapters since it lacks a pty-native restart strategy.
