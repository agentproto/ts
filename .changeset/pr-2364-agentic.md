---
"@agentproto/policy": minor
"@agentproto/runtime": minor
---

`@agentproto/policy` adds `evaluateGrants`/`combineDecisions` (a pure AIP-38 grant evaluator where a matching deny wins over any allow across composed policies, `default: deny` prevails, revoked/expired/condition-failing grants contribute nothing, and unresolvable scopes fail closed), `evaluateToolInvoke`/`qualifyToolName` for the `tool:invoke` action (exact `<server>/<name>`, `<server>/*`, `<server>/<prefix>*`, legacy bare built-in names qualified to `agentproto/<name>`, and `implements` actions decided together), plus the new `Grant.effect?: "allow" | "deny"` field.

`@agentproto/runtime` accepts an optional `PermissionContext.policy` (`{ inputs, principals?, now?, resolveSelector?, evaluateCondition? }`) read per call: an explicit deny removes the grant-derived `session.message` reasons (sibling/peer, never tree edges, operator or system), malformed grants refuse those same reasons, and the new `tool.invoke` action takes a `{ kind: "tool", name, implements? }` resource. No existing caller passes `policy`, so current decisions are unchanged.
