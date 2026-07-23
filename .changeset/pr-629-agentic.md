---
"@agentproto/cli": patch
"@agentproto/command-sandbox": minor
"@agentproto/driver-agent-cli": minor
"@agentproto/runtime": minor
---

Add config-file surface and `agent_start` MCP exposure for adapter-spawn command sandboxing (PR 6b continuation):

- **Config-file surface**: New `.agentproto/command-sandbox.json` `adapterSpawn` key (distinct from `command_execute`'s top-level `mode`) with separate env-var escape hatch (`AGENTPROTO_ADAPTER_COMMAND_SANDBOX_MODE`) to control adapter-spawn confinement persistently, justifying explicit opt-in due to larger blast radius.

- **MCP exposure**: `commandSandbox?: "off" | "workspace" | "strict"` added to `agent_start` schema; forwarded through runtime and driver layers.

- **Bug fix**: `serve.ts` was silently dropping `commandSandbox` from the opts destructure; fixed by including it in the spread and adding the type to `AgentAdapterResolver.startSession`.

- **Credential access gap** (PR 6a follow-up): Added read-only paths to adapter-spawn defaults (`~/.gitconfig`, `~/.config/git`, `~/.config/gh`, `~/Library/Keychains`) fixing `git ls-remote` and `gh auth status` failures under `workspace` mode confinement.

- **Async change**: `wrapAgentCliSpawn()` now async to support config-file loading; all callers updated.

Backwards compatible: default behavior unchanged when no config and no explicit mode.
