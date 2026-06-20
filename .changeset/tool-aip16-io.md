---
"@agentproto/tool": minor
"@agentproto/mcp-server": patch
---

tool: carry & validate AIP-16 `inputs`/`outputs` JSON Schema from manifests

A manifest-only `TOOL.md` (authored in YAML, no TS zod module — e.g. by an agent
self-constructing a tool) now keeps its declared IO contract: `inputs`/`outputs`
(JSON Schema, AIP-16) are modelled on the frontmatter schema and `ToolHandle`,
and carried through `parse` / `define` / `toolFromManifest` instead of being
silently dropped. `validateInput`/`validateOutput` validate against that JSON
Schema via `ajv` when no zod schema is present (zod stays the v0.1 path);
compiled validators are cached per schema in a `WeakMap`. Also fixes snake_case
meta surfacing on load (`risk_level`/`cost_class`/`timeout_ms` were lost to
defaults).

mcp-server: `buildMcpTool` tolerates a tool whose `inputSchema` is absent at
runtime (manifest-only) — it yields an empty MCP input shape instead of throwing.
