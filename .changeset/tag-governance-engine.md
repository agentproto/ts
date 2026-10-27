---
"@agentproto/governance-engine": major
---

Write the canonical AIP-70 `governance/v1` tag into new signature.json files and audit-log rows instead of `agentgovernance/v1`. Breaking for readers: files written by this version need @agentproto/governance-engine >= 0.2.0 and @agentproto/governance >= 0.2.0 to read. Existing legacy-tagged chains keep verifying because verification uses the tag stored in each row.
