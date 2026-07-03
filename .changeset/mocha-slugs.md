---
"@agentproto/driver-agent-cli": minor
"@agentproto/runtime": minor
"@agentproto/cli": patch
"@agentproto/adapter-hermes": minor
"@agentproto/adapter-claude-code": minor
"@agentproto/adapter-mastracode": patch
---

Add a common lean/skill launcher primitive for agent-CLI adapters, closing three gaps in the existing AIP-45 `modes`/`options` manifest schema:

- `bin_args_prepend` on both `modeSchema` and `optionSchema` (mirrored into `AGENT-CLI.schema.json`), for CLIs whose global flags must precede a subcommand baked into `bin_args` — e.g. hermes' `--ignore-user-config` has to come before `acp`, where `bin_args_append` lands it too late. `composeSpawn` now composes `[...prepend, ...bin_args, ...append]`.
- `agent_start` now plumbs an `options` map (`{ [optionId]: value }`) end to end — MCP tool input → `spawnAgentSession` → `AgentAdapterResolver.startSession` → `composeSpawn` — so option VALUES declared on a manifest actually reach spawn time, not just mode selection.
- Declared a `lean` mode (drop skills/context scaffolding to cut input-token overhead) on the three CLI adapters, using whatever real lever each one exposes: hermes gets `lean` (`--ignore-user-config`) and a `skills` option (`--skills {value}`) via `bin_args_prepend`; claude-code gets `lean` as an env-only mode (`CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`, since its ACP wrapper has no CLI flag for this); mastracode gets no `lean` mode — investigated and found no lever that reaches its headless invocation (the `MASTRACODE_DISABLE_*` env vars only wire into the interactive TUI entrypoint), documented in the manifest instead of fabricating a no-op flag.
