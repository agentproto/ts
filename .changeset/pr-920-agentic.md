---
"@agentproto/sandbox-e2b": patch
---

Separate integration tests from unit tests via dedicated vitest configs, add auth error handling (gracefully skip on 401/403), install hermes adapter in sandbox boot, and increase test timeout from 120s to 240s. Improves test reliability and maintainability without API changes.
