---
"@agentproto/catalog-sync": patch
---

Fix a failing live fetch during `catalog-sync generate --refresh` crashing the whole multi-provider run: a non-ok response now degrades to the committed snapshot (with a stderr note), mirroring the existing missing-env behavior; it still throws when no committed snapshot exists.
