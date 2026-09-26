---
"@agentproto/acp": minor
"@agentproto/runtime": minor
"agentproto-vscode": patch
---

feat(acp,runtime): carry stdio MCP-server `args`/`env` through to session/new

`AcpMcpServer` gains optional `args: string[]` and `env: Record<string, string>` (stdio only, ignored for http/sse). The fields are now accepted by the AIP-44 zod schema, the runtime `mcpServers` tool params, the `POST /sessions/agent` body parser, and mapped onto the ACP session/new wire shape (`env` as `[{ name, value }]`); the runtime mount pipeline forwards them to the spawned session. Spec JSON schema updated in lockstep.