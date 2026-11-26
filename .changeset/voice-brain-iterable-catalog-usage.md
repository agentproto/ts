---
"@agentproto/voice": minor
---

Add `deltasToIterable` (callback brain to `AsyncIterable<string>`) and `usageToCatalogEvents` / `catalogModelId` / `normalizeModelId` (usage record to billable events keyed by a catalog model id, per-provider mapping supplied by the host), so hosts stop copying them. Usage entries and catalog events carry an optional `credentialSource` (`platform` | `byok`), set with `UsageMeter.setCredentialSource`.
