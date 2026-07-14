---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Add local named terminal/TUI presets.

`sessions terminal` now accepts `--preset <name>` to load argv, env, cwd,
workspace, name and label from `terminalPresets.<name>` in
`~/.agentproto/config.json`. Explicit CLI flags still win, and raw
`-- <argv...>` launches work exactly as before.
