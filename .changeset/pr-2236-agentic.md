---
"@agentproto/agency": minor
"@agentproto/agency-v2": minor
---

Rename `@agentproto/agency-v2` to its AIP-70 registry name `@agentproto/agency`, keeping `@agentproto/agency-v2` as a deprecated re-export shim. `@agentproto/agency` now exports `defineAgency` alongside `defineAgencyV2` with `SPEC_NAME = "agency/v2"`.
