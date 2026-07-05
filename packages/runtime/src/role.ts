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
}

export const SUPERVISOR_ROLE: RoleProfile = {
  name: "supervisor",
  disposition:
    "You decompose, delegate, and verify. Prefer doing small work inline; " +
    "delegate the parts that genuinely benefit from a separate agent, and " +
    "check their output before relying on it.",
  toolPolicy: { delegation: "allow" },
}

const BUILTIN_ROLES: Readonly<Record<string, RoleProfile>> = {
  [EXECUTOR_ROLE.name]: EXECUTOR_ROLE,
  [SUPERVISOR_ROLE.name]: SUPERVISOR_ROLE,
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
 * @throws when `name` is given but unrecognized (a caller typo should
 * fail loudly rather than silently fall back to a default role).
 */
export function resolveRole(
  name: string | undefined,
  depth: number,
  cutoff: number = DEFAULT_ROLE_DEPTH_CUTOFF,
): RoleProfile {
  if (name !== undefined) {
    const role = BUILTIN_ROLES[name]
    if (!role) {
      const known = Object.keys(BUILTIN_ROLES).join(", ")
      throw new Error(`resolveRole: unknown role "${name}" — expected one of: ${known}.`)
    }
    return role
  }
  return depth < cutoff ? SUPERVISOR_ROLE : EXECUTOR_ROLE
}

/**
 * Compose the child's effective system-context text. `promptAppend`
 * layers ON TOP of the disposition — it specializes, it can never
 * replace it (and, independently, it can never re-open the tool gate
 * `toolPolicy` enforces — see `DELEGATION_TOOL_NAMES` gating in
 * `session-spawn.ts`).
 */
export function composeRoleContext(role: RoleProfile, promptAppend?: string): string {
  return promptAppend ? `${role.disposition}\n\n${promptAppend}` : role.disposition
}
