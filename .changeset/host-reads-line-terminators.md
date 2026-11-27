---
"@agentproto/app": patch
---

`boundaries.hostReads`: the loader and `defineApp` now refuse an entry holding a line terminator (`\n`, `\r`, U+2028, U+2029) anywhere, like the AIP-53 APP.schema.json pattern does. `HOST_READ_PATH_RE` is now the schema's own pattern, anchored at both ends.
