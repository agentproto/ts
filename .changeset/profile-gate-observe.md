---
"@agentproto/runtime": minor
---

A spawn that names an auth profile outside its caller's set (the caller's own profile plus `defaults.spawn.sharedProfiles`) is now counted by an `observe`-by-default `defaults.spawn.profileGate`, readable on `GET /permissions/grants` under `profileUse`. Setting the gate to `enforce` refuses that spawn with `auth_profile_denied`.
