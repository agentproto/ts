---
"@agentproto/runtime": minor
---

Role registry + pack-carried role definitions + privilege-lattice spawn gate +
role introspection. resolveRole now resolves custom roles installed as role
packs (ROLE.md folders, discovered like skill packs), not just the two
built-ins. RoleProfile gains `level` (privilege) and optional `spawnableRoles`
allowlist: a parent may spawn a child role only if it is explicitly allowlisted,
or (default, open mode) the child's level is at or below the parent's —
enforced at the daemon spawn point via a single `canSpawn` predicate, no
pre-enumeration of children required. That same predicate powers `listRoles` /
`spawnableRolesFor`, a `Roles you may spawn: …` line injected into a delegating
role's context, and a read-only `role_list` MCP tool. Built-ins keep
byte-identical behavior; with no role packs installed nothing changes.
