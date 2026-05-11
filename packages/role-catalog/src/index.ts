/**
 * @agentproto/role-catalog — AIP-47 reference catalogue of builtin roles.
 *
 * Ships twenty starter ROLE.md manifests spanning the nine recommended
 * departments. Each entry is a validated `RoleHandle` (per
 * `@agentproto/role`'s `ROLE.schema.json`) paired with body markdown
 * covering background, working principles, and escalation.
 *
 * Roles are **doctype-agnostic**: any AIP-9 OPERATOR or human member
 * can wear any of these manifests. Curation / sort order / soft tags
 * in consumer UIs handle positioning concerns (e.g. "manager-level
 * roles are more typical for AI workers than C-suite ones in 2026"),
 * not a typed `audience` field on the manifest.
 *
 * Process-wide singleton — `builtinRoleSource()` returns the SAME
 * `BuiltinRoleSource` on every call (backed by an AIP-43 registry).
 * Downstream apps may extend the catalogue via `registerBuiltinRoles`
 * without forking the OSS package:
 *
 *   import { registerBuiltinRoles } from "@agentproto/role-catalog"
 *   registerBuiltinRoles([
 *     { slug: "guild-admin", handle: {...}, body: "..." },
 *   ])
 *
 * Composing the catalogue into a resolver chain:
 *
 *   import { resolveRole } from "@agentproto/role"
 *   import { builtinRoleSource } from "@agentproto/role-catalog"
 *
 *   const result = await resolveRole("marketing-manager", {
 *     sources: [builtinRoleSource()],
 *   })
 *
 * Spec: https://agentproto.sh/docs/aip-47
 */

import { BuiltinRoleSource, type BuiltinRoleEntry } from "@agentproto/role"
import { BUILTIN_ROLE_ENTRIES } from "./builtins.js"

export {
  BUILTIN_ROLE_ENTRIES,
  BUILTIN_ROLE_SLUGS,
  LEGACY_GUILDE_ROLE_MAP,
} from "./builtins.js"

/**
 * Process-wide singleton — the canonical builtin registry for this
 * runtime. Bootstrapped lazily on first access with
 * `BUILTIN_ROLE_ENTRIES` (the 20 OSS starters); subsequent
 * `registerBuiltinRoles(...)` calls extend it in place.
 *
 * `builtinRoleSource()` returns this singleton — multiple calls
 * share the same registry, so any registration anywhere in the
 * process is visible to every consumer.
 */
let singletonSource: BuiltinRoleSource | null = null

function getSingletonSource(): BuiltinRoleSource {
  if (singletonSource) return singletonSource
  singletonSource = new BuiltinRoleSource(BUILTIN_ROLE_ENTRIES)
  return singletonSource
}

/**
 * Return the process-wide singleton `BuiltinRoleSource`. Wraps the
 * OSS catalogue (20 starters) plus any entries registered through
 * `registerBuiltinRoles`. Safe to call from any module at any time —
 * the registry is lazily bootstrapped on first access.
 */
export function builtinRoleSource(): BuiltinRoleSource {
  return getSingletonSource()
}

/**
 * Register additional builtin roles into the process-wide registry.
 * Use this when a downstream package (a vendor runtime, a host app)
 * ships its own builtin roles ALONGSIDE the OSS catalogue without
 * forking `@agentproto/role-catalog`.
 *
 * Throws `RegistryDuplicateError` from `@agentproto/registry` if a
 * slug already exists — the catalogue is intended to be additive,
 * not overwriting. Call `replaceBuiltinRole(entry)` if a slug rev
 * needs to swap atomically.
 *
 * Boot-time call site is the right pattern — every consumer of
 * `builtinRoleSource()` after `registerBuiltinRoles` sees the
 * additions.
 */
export function registerBuiltinRoles(
  entries: Iterable<BuiltinRoleEntry>,
): void {
  const source = getSingletonSource()
  for (const entry of entries) {
    source.register(entry)
  }
}

/**
 * Replace an existing builtin role with a new version of the same
 * slug. Throws `RegistryNotFoundError` if no entry exists at the
 * slug — use `registerBuiltinRoles` for new slugs.
 */
export function replaceBuiltinRole(entry: BuiltinRoleEntry): void {
  getSingletonSource().replace(entry)
}

/**
 * Remove a builtin role from the registry. Returns true if the slug
 * was present. Use sparingly — the registry is intended to be
 * boot-time-stable; mid-flight unregister of an OSS starter risks
 * resolver fall-through to file/db sources mid-conversation.
 */
export function unregisterBuiltinRole(slug: string): boolean {
  return getSingletonSource().unregister(slug)
}
