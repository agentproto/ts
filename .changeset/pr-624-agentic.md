---
"@agentproto/runtime": minor
---

Export orphan reaping utilities for custom orchestrator implementations. Adds `reapOrphanedDescendants` function and `OrphanReaperRegistry` interface to the public API, enabling users to implement custom child-session lifecycle management when parent sessions exit.
