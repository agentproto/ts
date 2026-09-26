---
"@agentproto/auth": minor
"@agentproto/runtime": minor
---

Add `updateAuthProfile` (metadata-only patch for `label`/`costBudget`) to @agentproto/auth, exposed as the `auth_profile_update` MCP tool and a `PATCH /auth/profiles/:id` HTTP route in @agentproto/runtime. Tri-state per field: omit to leave, `null` to clear. Never touches credentials or `credentialRef`.
