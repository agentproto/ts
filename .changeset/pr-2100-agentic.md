---
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

Ship `docs/mcp-tools` alongside the bundled `cli.mjs` so `tool_help` and `agentproto help <tool>` find long tool docs in the published CLI package. The CLI build now copies `runtime/docs/mcp-tools` into the CLI package and lists `docs` in `files`; a new bundled-layout test in the runtime package guards the resolution path.
