---
"@agentproto/mcp-server": minor
"@agentproto/runtime": minor
---

Serve the beta MCP Skills extension (`io.modelcontextprotocol/skills`) on the 2026-07-28 era of the root `/mcp` gateway: `skills/list`, `skills/get` and `skill://<name>/<path>` reads through `resources/read`, backed by the imported-skills registry only (application skills are not served). Each skill carries its frontmatter verbatim and a manifest of files with `sha256` digests over raw bytes; a skill above 512 files / 16 MiB is not served and says why, and paths are confined to the skill folder. `server/discover` announces the extension and the `resources` capability. Switch it off with `mcp.extensions.skills=false`; the legacy 2025-11-25 path and the spawn-time skill delivery are unchanged. `@agentproto/mcp-server` exports `registerSkillsMethods`.
