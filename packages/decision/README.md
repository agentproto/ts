# @agentproto/decision

The AIP-65 DECISION.md core (`decision/v1`):

- `parseDecisionPolicy` and the DECISION.md frontmatter schema
- `collectEvidence`: bounded, secret-scrubbed evidence for a policy
- `decide`: rules-first typed decisions with a bounded classifier call, one bounded escalation, a conservative default, and a shared cache
