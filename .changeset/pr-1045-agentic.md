---
"@agentproto/runtime": patch
"agentproto-vscode": patch
---

Fix text fragment rejoining logic to use only the explicit `partial` flag instead of heuristic `endsWith("\n")` check. This prevents complete text blocks from being incorrectly concatenated when tool calls interleave, which was causing paragraphs to run together (e.g., "…the client.Trial logic…"). The writer's transcript contract emits end-of-message blocks as non-partial records without trailing newlines, making the explicit `partial: true` flag the only reliable glue signal.
