---
"@agentproto/auth": minor
"@agentproto/app-kit": minor
---

Republish auth (eligibleProfiles export, added in #470 but never versioned)
and app-kit (WorkspaceShorthand / optional `workspace` on AppDefinition,
added in #468 but never versioned) to fix npm publish skew — #468 touched
`packages/app-kit/src/types.ts`, not `@agentproto/workspace`, so app-kit is
the stale published artifact, not workspace.
