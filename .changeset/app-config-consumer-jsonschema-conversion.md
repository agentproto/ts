---
"@agentproto/app-config": minor
---

`jsonSchemas(opts?)` accepts a consumer-supplied `toJSONSchema` conversion. By default the kit still converts with its own zod copy, but a consumer pinned to a different zod minor can now delegate the emit, so committed JSON Schemas regenerate identically (e.g. nullable fields emit the consumer zod's `anyOf` form instead of the kit zod's `type: ["string","null"]`).
