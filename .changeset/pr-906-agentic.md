---
"@agentproto/runtime": minor
---

Add harness→profile preset persistence (`~/.agentproto/harness-presets.json`). Eliminates re-picking auth profiles per spawn by storing which profile + default model each adapter harness should bill through. Includes full CRUD store with validation (profile existence, model curation), MCP tools for remote management, and clean spawn-path integration at the correct precedence level (lowest — only fills unpinned profile/model).
