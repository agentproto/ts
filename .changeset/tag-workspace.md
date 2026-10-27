---
"@agentproto/workspace": major
---

Emit the canonical AIP-70 tags `workspace.export/v1` (EXPORT.md), `workspace.lock/v1` and `review.pack-digest/v1:` pack digests (agentproto.lock), and `workspace.types/v1` (TYPES.md) instead of the legacy `workspace-export/v1`, `agentproto-lock/v1`, `agentproto-pack-digest/v1` and `workspace-types/v1`. Breaking for readers: files written by this version need @agentproto/workspace >= 1.1.0 to read. Readers of this version still accept the legacy tags.
