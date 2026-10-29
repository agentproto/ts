---
"@agentproto/agent": minor
"@agentproto/operator": minor
"@agentproto/runtime": minor
"@agentproto/bridge": patch
"@agentproto/app": patch
"@agentproto/memory": patch
"@agentproto/corpus": patch
---

AGENT.md `tools` accepts the AIP-42 structured item `{ kind: mcp, server, allow?, deny? }` and refuses a malformed one (missing `server`, a `/` in a server or tool name, an extra key, an unknown `kind`); the item is part of the generated agent schema and exported as `McpToolRef` / `ToolRef`. The operator `tools` item is that same schema, taken from the agent package by reference, and still accepts the deprecated scoped form `{ id, source?, scope? }`. `projectAgentToSpawn` folds each structured item into a per-server `allowTools` / `denyTools` (`servers` on the projection) instead of dropping it with a warning; a deny wins over an allow and over any other item admitting the same tool, and a bare string joins the `agentproto` server. The spec generator gains `--inline-ref <def>` and proves disjoint closed-object `oneOf` branches, so the agent package is now covered by `check:spec-drift`. The vendored specs are re-synced, which regenerates the memory frontmatter schema line; the bridge and `refKey` in the app package take the widened `ToolRef` (a server ref keys as `mcp:<server>`), and the corpus conformance fixtures register the AIP-42 AGENT external that the re-synced OPERATOR schema now references.
