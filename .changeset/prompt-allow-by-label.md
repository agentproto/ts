---
"@agentproto/runtime": patch
---

`allowPromptFrom` entries may now name callers by session label: `label:<exact label>` grants a caller whose registered label matches, `label:<prefix>*` grants any caller whose label starts with the prefix, and the grant survives the caller restarting under a new session id.
