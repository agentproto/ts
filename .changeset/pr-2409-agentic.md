---
"@agentproto/runtime": minor
---

AIP-46 auth-profile gate for spawns that name an access profile: `defaults.spawn.profileGate` (off/observe/enforce, observe by default) evaluates `access.profileRef` and every `access.profileRefs` entry against the calling session's own profile plus `defaults.spawn.sharedProfiles`. `observe` counts would-deny verdicts, exposed on `GET /permissions/grants` under `profileUse`; `enforce` refuses with `auth_profile_denied`. Also adds the routed `auth.profile.use` decision and `permissions_explain` support for a `profile` ref.
