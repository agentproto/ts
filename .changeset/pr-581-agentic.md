---
"@agentproto/runtime": minor
---

Add macOS Seatbelt-based OS-level confinement for `command_execute` subprocesses (phase 2). Introduces opt-in `.agentproto/command-sandbox.json` config with three modes: "off" (default, no change), "workspace" (deny access to home directory outside workspace, protect credentials), and "strict" (add network denial). Backends are platform-specific; returns null on non-macOS platforms. Original command/args preserved in provenance; only spawned argv is wrapped. Comprehensive test coverage including end-to-end macOS Seatbelt validation.
