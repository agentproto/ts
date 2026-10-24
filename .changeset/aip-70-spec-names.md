---
"@agentproto/governance": minor
"@agentproto/governance-engine": minor
"@agentproto/operator": minor
---

Accept the AIP-70 registry spec names on every read path and keep emitting the legacy tags for now. `@agentproto/governance` exports `SPEC_NAME = "governance/v1"` plus `LEGACY_SPEC_NAMES` and `EMITTED_SPEC_NAME`; the signature, audit-event, and policy schemas accept `governance/v1` and `agentgovernance/v1`, while newly signed artifacts, audit rows, and policy handles still carry `agentgovernance/v1` (it flips to the new name at the next major; old verifiers in the field only know the old tag, and the tag is part of the hashed audit-row bytes, so verification always uses the tag stored in the row). `@agentproto/operator` sets `SPEC_NAME = "operator/v1"` and its OPERATOR.md frontmatter enum now accepts `operator/v1` alongside the legacy `agentoperators/v1` and `agentoperator/v1`.
