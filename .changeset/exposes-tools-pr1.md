---
"@agentproto/app": minor
"@agentproto/cli": minor
---

APP.md gains `exposes.prefix` and `exposes.tools` (`{ id, access: read|write|approve, description, inputSchema?, mcpName?, approvalArg? }`), validated at load: `read` is refused on a mutator-tagged or `mutates` tool, `approval*` ids and colliding MCP names are refused. `exposedToolName` is the single place that computes the MCP name (`<prefix>_<name>`, never `:` or `/`). `agentproto mcp-app` registers only `--access read` tools by default (`--access read,write` to opt in), with their real input schema and `readOnlyHint`/`destructiveHint`, and still forwards the original tool id to the daemon. An app without `exposes.tools` keeps the old behavior with a stderr warning. Daemon registration of these tools is not part of this change.
