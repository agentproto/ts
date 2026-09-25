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
  /**
   * Role-level default for the daemon self-mount's deferred/lazy tool
   * loading (harness-parity item 3 — see `deferred-tools.ts`). Applied to
   * the injected `mcpServers` entry (`session-spawn.ts`'s
   * `shouldInjectDaemonSelfMount` path) as `?deferred=1|0` when the spawn
   * itself didn't pass an explicit `deferredTools` override. Undefined ⇒
   * no role-level opinion, the gateway's own boot-time default
   * (`defaults.mcp.deferredTools` in config.json) applies unchanged.
   */
  deferredTools?: boolean
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
    "You are the executor. Do the task yourself, using only the tools " +
    "provided — never spawn or delegate to another agent, even if it " +
    "looks convenient. This includes any subagent/Task tool your own " +
    "CLI ships natively: it is not routed through agentproto and this " +
    "daemon cannot strip it out, so the rule holds regardless of which " +
    "tools appear available to you.",
  toolPolicy: { delegation: "deny" },
  skills: [],
  // The floor of the lattice — in practice spawns nothing, since
  // `toolPolicy.delegation: "deny"` already strips `agent_start` before
  // the level comparison is ever reached. NOTE: that strip only covers
  // the daemon's own MCP gateway (agent_start/agent_prompt) — a native
  // subagent/Task tool bundled with the CLI itself (e.g. claude-code's
  // Task tool) isn't an MCP tool and can't be gated here at all, which
  // is why the disposition above spells it out explicitly.
  level: 0,
  // Executors are the primary consumer of the deferred-tools surface: they
  // never delegate (agent_start/agent_prompt are already stripped above),
  // so the bulk of the ~190-tool daemon gateway is dead weight at turn 0.
  // Default ON regardless of the daemon's own global
  // `defaults.mcp.deferredTools` setting — an operator who hasn't opted the
  // whole daemon in still gets a lean executor by default.
  deferredTools: true,
}

export const SUPERVISOR_ROLE: RoleProfile = {
  name: "supervisor",
  disposition:
    "You are the supervisor. Decompose the work and delegate the parts " +
    "that genuinely benefit from a separate agent, then verify each " +
    "result before relying on it. Delegate through the `agent_start` " +
    "MCP tool (on the `agentproto` MCP server), not your CLI's native " +
    "subagent/Task tool — a native subagent is invisible to this daemon " +
    "(no session id, no tracking, no kill switch), whereas agent_start " +
    "gives you a session you can observe and supervise. Prefer doing " +
    "small work inline.",
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
 * What a spawned session can ACTUALLY reach of the delegation surface
 * (`agent_start`/`agent_prompt`), computed from the MCP mounts it ends up
 * with (see `delegationReachFor` in `session-spawn.ts`) — as opposed to
 * what its role merely permits. A role can allow delegation while the
 * session has no daemon mount at all (an adapter outside the self-mount
 * set, an explicit `mcpServers: []`, a mount carrying `denyTools=
 * agent_start`); promising it `agent_start` then sends it hunting for a
 * tool that isn't there.
 */
export interface DelegationReach {
  /** `agent_start` is registered on at least one of the session's MCP
   *  mounts (the daemon's `/mcp` without a deny, or an orchestrator scope
   *  that carries it). */
  reachable: boolean
  /** The mount that carries it lists tools lazily (deferred tools on), so
   *  the session may have to `tool_search` for it. */
  deferred?: boolean
}

/**
 * Resolve a role by name, or — when `name` is omitted — derive one
 * from spawn depth against `cutoff`. Pure; no fs, no adapter I/O.
 *
 * `reach`, when given, only affects the DEFAULT (no `name`): a session
 * that can't reach `agent_start` defaults to executor at any depth. An
 * explicit `name` is always honoured — `composeRoleContext` is what keeps
 * its text honest then.
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
  reach?: DelegationReach,
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
  // A defaulted supervisor that won't actually be able to reach
  // `agent_start` is a supervisor in name only — default it to executor
  // instead, so the role (and the disposition composed from it) matches
  // the tools the session really has.
  if (reach && !reach.reachable) return EXECUTOR_ROLE
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
 *
 * `reach` (see `DelegationReach`) keeps the text true to the session's
 * real tools: a role that allows delegation but can't reach `agent_start`
 * gets the EXECUTOR disposition and no spawn line — never a promise of a
 * tool it doesn't have. When it can reach it and the mount is deferred,
 * the where-to-find-it line also points at `tool_search`. Omitted ⇒
 * delegation assumed reachable and eager (the pre-reach behaviour).
 */
export function composeRoleContext(
  role: RoleProfile,
  promptAppend?: string,
  registry?: Readonly<Record<string, RoleProfile>>,
  reach?: DelegationReach,
): string {
  if (role.toolPolicy.delegation === "allow" && reach && !reach.reachable) {
    return [EXECUTOR_ROLE.disposition, promptAppend].filter((p): p is string => !!p).join("\n\n")
  }
  const spawnable = spawnableRolesFor(role, registry)
  const spawnLine =
    spawnable.length > 0
      ? `Roles you may spawn: ${spawnable.map(r => r.name).join(", ")}.`
      : undefined
  const toolLine = spawnable.length > 0 ? delegationToolLine(reach?.deferred === true) : undefined
  return [role.disposition, spawnLine, toolLine, promptAppend]
    .filter((p): p is string => !!p)
    .join("\n\n")
}

/**
 * Where a delegating session finds its delegation tools — named exactly
 * (MCP tool + server), with the deferred-mount `tool_search` hint when it
 * applies and the CLI equivalents (`packages/cli/src/commands/sessions.ts`)
 * for a session that only has a shell.
 */
function delegationToolLine(deferred: boolean): string {
  return [
    "`agent_start` (spawn a child) and `agent_prompt` (send a child a " +
      "follow-up) are MCP tools on the `agentproto` MCP server.",
    deferred
      ? "That server loads tools lazily: if they aren't in your tool list, " +
        "find them with its `tool_search` tool (`select:agent_start,agent_prompt`)."
      : undefined,
    "With only a shell, the CLI equivalents are " +
      '`agentproto sessions start <adapter> --prompt "<task>"` and ' +
      '`agentproto sessions prompt <id> --prompt "<text>"`.',
  ]
    .filter((p): p is string => !!p)
    .join(" ")
}
