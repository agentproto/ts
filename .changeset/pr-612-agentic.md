---
agentproto-vscode: minor
---

Add posture (mode) and access profile (auth/wallet) chips to the transcript composer bar. Users can now click these chips to open the unified session config picker and switch posture or access profile mid-conversation. The new `postureLabel()` helper renders both canonical and harness-mode postures as strings. UI fallback labels ("posture?", "no wallet") are always visible to indicate these fields can be configured, improving discoverability.
