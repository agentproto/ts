---
"@agentproto/driver-agent-cli": minor
---

Slash-command dispatch decision util (AIP-44 available_commands groundwork):
pure `slash-dispatch` module — `parseSlashInvocation`, `matchSlashCommand`,
`classifySlashPrompt`, `asSlashPromptBlocks` — that classifies a leading
`/name` prompt against the adapter's own `available_commands_update` list
(hermes `SlashCommandsMixin`, claude-agent-acp `sendAvailableCommandsUpdate`,
opencode ACP directory snapshot) and pins the transport contract: dispatch is
adapter-side on the verbatim first text block, so host-side prepends
(reasoning digests, fyi inbox digests, resume-context digests) keep slash
commands from ever reaching the adapter's dispatcher.
