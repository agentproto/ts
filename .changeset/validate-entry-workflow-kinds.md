---
"@agentproto/cli": patch
---

`agentproto app validate` (and so `catalog verify`) accepts the runtime node kinds `transform`, `pipeline` and `group` in an entry-based workflow (`entry: ./entry.mjs`), whose manifest the loader requires to mirror the code graph kind for kind. A manifest-only workflow using them is still rejected, per AIP-15.
