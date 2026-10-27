---
"@agentproto/governance": major
---

Emit the canonical AIP-70 `governance/v1` tag in new policy handles (`EMITTED_SPEC_NAME` is now `SPEC_NAME`) instead of `agentgovernance/v1`. Breaking for readers: files written by this version need @agentproto/governance >= 0.2.0 to read. Readers of this version still accept `agentgovernance/v1`.
