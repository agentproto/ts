/**
 * Spawn-time role profiles — the primitive that decides whether a
 * spawned agent may itself delegate (spawn further children).
 *
 * A role is 3 layers:
 *   - `disposition`  — a system-prompt fragment. Soft: sets the mindset.
 *   - `toolPolicy`   — whether delegation tools are injected into the
 *     child at all. HARD: enforced by the daemon at the `agent_start`
 *     injection point (`session-spawn.ts`), not by the child's own
 *     behaviour. A child cannot widen its own `toolPolicy` — not via
 *     `promptAppend`, not by requesting `orchestrator` itself.
 *   - `skills[]`     — role-specific skill set (built-ins ship empty/
 *     unset; a future pack-carried role can populate this).
 *
 * Why the asymmetry matters: a process can bring its own disposition
 * and skills (those are portable, could live in a skill/pack), but it
 * can never strip tools the daemon already injected into it. Only the
 * spawner controls that — which is exactly why `toolPolicy` must be
 * resolved and enforced here, at spawn time, rather than left to a
 * prompt instruction the model could rationalize past.
 */

export type DelegationPolicy = "allow" | "deny"

export interface RoleToolPolicy {
  delegation: DelegationPolicy
}

export interface RoleProfile {
  name: string
  disposition: string
  toolPolicy: RoleToolPolicy
  skills?: string[]
  /**
   * Privilege level in the spawn lattice. Higher = more privileged.
   * The default spawn-gate rule (`canSpawn`) is non-escalation: a
   * parent may spawn a child only when `child.level <= parent.level`
   * — peers and subordinates are fine, spawning something MORE
   * privileged than yourself is not. (Unbounded same-level recursion —
   * e.g. supervisor spawning supervisor spawning supervisor — is a
   * pre-existing, deliberate pattern bounded separately by
   * `maxDepth`/`maxChildren`, not this lattice; see `spawnableRoles`
   * below for a role that also needs to cap recursion itself.)
   * `spawnableRoles` (below), when set, opts a role into a closed
   * allowlist instead — level is then only used for display/ordering.
   */
  level: number
  /**
   * Closed allowlist of role names this role may spawn, by name — the
   * opt-in "figé pipeline" mode. When set, `canSpawn` checks name
   * membership instead of the level comparison. Undefined (the
   * default, open mode) ⇒ non-escalation by `level`.
   */
  spawnableRoles?: string[]
}

/**
 * MCP tool names that let a child spawn or drive further children.
 * This is the minimum "delegation surface" gated by `toolPolicy.
 * delegation`: `agent_start` (spawn) and `agent_prompt` (drive an
 * already-spawned child). Any future Task/subagent-spawn tool belongs
 * in this list too.
 */
export const DELEGATION_TOOL_NAMES: readonly string[] = [
  "agent_start",
  "agent_prompt",
]

export const EXECUTOR_ROLE: RoleProfile = {
  name: "executor",
  disposition:
    "You are the leaf. You execute the task yourself — you do not spawn " +
    "or delegate to another agent, even if it seems convenient or the " +
    "task looks complex. Do the work directly with the tools you have.",
  toolPolicy: { delegation: "deny" },
  skills: [],
  // The floor of the lattice — in practice spawns nothing, since
  // `toolPolicy.delegation: "deny"` already strips `agent_start` before
  // the level comparison is ever reached.
  level: 0,
}

export const SUPERVISOR_ROLE: RoleProfile = {
  name: "supervisor",
  disposition:
    "You decompose, delegate, and verify. Prefer doing small work inline; " +
    "delegate the parts that genuinely benefit from a separate agent, and " +
    "check their output before relying on it.",
  toolPolicy: { delegation: "allow" },
  level: 100,
}

const BUILTIN_ROLES: Readonly<Record<string, RoleProfile>> = {
  [EXECUTOR_ROLE.name]: EXECUTOR_ROLE,
  [SUPERVISOR_ROLE.name]: SUPERVISOR_ROLE,
}

/**
 * Merge a custom (pack-carried) registry with the two built-ins.
 * Built-ins ALWAYS win a name collision — a pack cannot shadow
 * `executor`/`supervisor` and can't widen the floor it's built on.
 * The single place this rule lives; every consumer below
 * (`resolveRole`, `listRoles`, `spawnableRolesFor`) merges through
 * this function so they can never disagree about a name.
 */
export function mergeRoleRegistry(
  custom?: Readonly<Record<string, RoleProfile>>,
): Record<string, RoleProfile> {
  return { ...custom, ...BUILTIN_ROLES }
}

/**
 * Depth cutoff separating the depth-derived defaults when a spawn
 * passes no explicit `role`: `depth < cutoff` → supervisor, `depth >=
 * cutoff` → executor. Overridable via config.json's
 * `defaults.defaultRoleDepthCutoff` (see `SpawnDefaultsConfig`).
 */
export const DEFAULT_ROLE_DEPTH_CUTOFF = 1

/**
 * Resolve a role by name, or — when `name` is omitted — derive one
 * from spawn depth against `cutoff`. Pure; no fs, no adapter I/O.
 *
 * `registry`, when given, is a custom (pack-carried) registry merged
 * with the two built-ins (built-ins win — see `mergeRoleRegistry`).
 * Omitted ⇒ built-ins only, byte-identical to #214.
 *
 * @throws when `name` is given but unrecognized (a caller typo should
 * fail loudly rather than silently fall back to a default role).
 */
export function resolveRole(
  name: string | undefined,
  depth: number,
  cutoff: number = DEFAULT_ROLE_DEPTH_CUTOFF,
  registry?: Readonly<Record<string, RoleProfile>>,
): RoleProfile {
  if (name !== undefined) {
    const roles = registry ? mergeRoleRegistry(registry) : BUILTIN_ROLES
    const role = roles[name]
    if (!role) {
      const known = Object.keys(roles).join(", ")
      throw new Error(`resolveRole: unknown role "${name}" — expected one of: ${known}.`)
    }
    return role
  }
  return depth < cutoff ? SUPERVISOR_ROLE : EXECUTOR_ROLE
}

/**
 * List every role in the merged registry (built-ins + `registry`).
 * Pure; no fs. Omit `registry` for built-ins only.
 */
export function listRoles(
  registry?: Readonly<Record<string, RoleProfile>>,
): RoleProfile[] {
  return Object.values(mergeRoleRegistry(registry))
}

/**
 * THE single source of truth for whether `parent` may spawn `child` —
 * shared by the hard spawn gate (`session-spawn.ts`) and every
 * introspection surface (`spawnableRolesFor`, `role_list`, the "Roles
 * you may spawn" context line) so they can never disagree.
 *
 * A role whose OWN `toolPolicy.delegation` is `"deny"` can spawn
 * NOTHING, full stop — the lattice below is moot once the tools
 * themselves are stripped (this is what makes `EXECUTOR_ROLE`, in
 * practice, unable to spawn even a peer at its own floor level, and
 * what makes `composeRoleContext`/`role_list` correctly show an empty
 * spawnable set for it).
 *
 * When delegation is allowed, `parent.spawnableRoles`, if set, is a
 * closed allowlist checked by name. Otherwise (the default, open mode)
 * it's non-escalation: `child.level <= parent.level` — a role may
 * spawn a peer or a subordinate, never something more privileged than
 * itself. (Unbounded same-level recursion is a pre-existing, deliberate
 * pattern bounded separately by `maxDepth`/`maxChildren`, not this
 * lattice.)
 */
export function canSpawn(parent: RoleProfile, child: RoleProfile): boolean {
  if (parent.toolPolicy.delegation === "deny") return false
  if (parent.spawnableRoles) return parent.spawnableRoles.includes(child.name)
  return child.level <= parent.level
}

/** Every role in the merged registry that `parent` may spawn, per
 *  `canSpawn`. Pure; no fs. */
export function spawnableRolesFor(
  parent: RoleProfile,
  registry?: Readonly<Record<string, RoleProfile>>,
): RoleProfile[] {
  return listRoles(registry).filter(child => canSpawn(parent, child))
}

/**
 * Compose the child's effective system-context text:
 *   disposition + (optional) "Roles you may spawn: …" line + (optional)
 *   promptAppend — in that order. `promptAppend` layers ON TOP of the
 *   disposition — it specializes, it can never replace it (and,
 *   independently, it can never re-open the tool gate `toolPolicy`
 *   enforces — see `DELEGATION_TOOL_NAMES` gating in
 *   `session-spawn.ts`).
 *
 * The spawn-line lets a delegating role KNOW its options at runtime
 * instead of guessing — omitted entirely when `spawnableRolesFor`
 * returns empty (a leaf/executor sees nothing extra).
 */
export function composeRoleContext(
  role: RoleProfile,
  promptAppend?: string,
  registry?: Readonly<Record<string, RoleProfile>>,
): string {
  const spawnable = spawnableRolesFor(role, registry)
  const spawnLine =
    spawnable.length > 0
      ? `Roles you may spawn: ${spawnable.map(r => r.name).join(", ")}.`
      : undefined
  return [role.disposition, spawnLine, promptAppend].filter((p): p is string => !!p).join("\n\n")
}
