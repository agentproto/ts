---
"@agentproto/auth": minor
"@agentproto/runtime": minor
---

feat(auth,runtime): auth-profile create/delete flow. Provision named subscription and api-key auth profiles from the daemon via the `auth_profile_create` / `auth_profile_delete` MCP verbs, backed by a `profile-provision` helper that writes the profile descriptor and stores the credential in the OS keychain. Surfaced in VS Code as a create/delete UI on the auth-profiles tree.
