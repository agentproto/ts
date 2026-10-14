---
"@agentproto/runtime": minor
"@agentproto/driver-agent-cli": minor
"@agentproto/acp": minor
"@agentproto/workflow-runtime": minor
"@agentproto/adapter-claude-code": patch
"@agentproto/adapter-opencode": patch
"@agentproto/adapter-codex": patch
"@agentproto/adapter-pi": patch
"@agentproto/cli": patch
---

Harness-neutral system-prompt channel for AIP-42 AGENT.md projection. An adapter whose manifest declares `systemPrompt` now receives the projected AGENT.md text through that channel instead of as a first-prompt prefix, and no `session:harness-warning` is raised for it. Three `via` channels: `acp-meta` (claude-code — ACP `_meta.systemPrompt.append` on `session/new` and `session/load`), `inline-config` (opencode `instructions` file path and codex `developer_instructions`, layered into the CLI's inline JSON config env var) and `argv` (pi's `--append-system-prompt`, on every spawn including resume). Every other adapter keeps today's prefix + warning behaviour, and a sandbox spawn still warns — the box owns its own adapter configuration.
