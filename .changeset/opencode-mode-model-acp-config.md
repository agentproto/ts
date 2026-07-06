---
"@agentproto/adapter-opencode": patch
"@agentproto/acp": patch
"@agentproto/driver-agent-cli": patch
---

Fix opencode adapter crashing on `mode` and `model` selection. `opencode acp` has no `--mode`/`--model` CLI flags — passing either crashed the spawned subprocess before ACP could connect. Both are now applied via ACP `session/set_config_option` after `session/new`, matching how opencode's own ACP server models them. Adds a `AgentCliMode.apply: "config"` switch (mirroring the existing `AgentCliModels.apply`) so a mode can opt out of argv/env composition and instead be forwarded to the protocol arm's `connect({mode})`.
