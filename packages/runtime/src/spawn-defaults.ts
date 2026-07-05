/**
 * Pure resolver for `~/.agentproto/config.json`'s `defaults` block —
 * computes the effective `skills` + `options` for an `agent_start` spawn
 * before adapter-specific normalization. No fs, no adapter I/O, so it's
 * unit-testable in isolation from `session-spawn.ts` (which owns the fs
 * read + the adapter-manifest lookup).
 *
 * Precedence (lowest → highest): global `defaults` < `defaults.adapters.
 * <slug>` < the explicit `agent_start` call.
 *   - `options`: shallow-merged maps, later (higher-precedence) keys win.
 *   - `skills`: global ∪ per-adapter when the caller didn't pass `skills`
 *     at all; an explicit `skills` (even `[]`) REPLACES the union rather
 *     than merging into it — a deliberate exact set, mirroring how an
 *     explicit `mcpServers: []` opts out of the hermes default in
 *     `session-spawn.ts`.
 */

export interface DefaultsAdapterConfig {
  skills?: string[]
  options?: Record<string, boolean | number | string>
}

/** Shape of `config.json`'s top-level `defaults` block. */
export interface SpawnDefaultsConfig {
  skills?: string[]
  options?: Record<string, boolean | number | string>
  adapters?: Record<string, DefaultsAdapterConfig>
  /** Depth cutoff for the role-derived default (see `resolveRole` in
   *  `role.ts`) applied when an `agent_start` call omits `role`:
   *  `depth < cutoff` → supervisor, `depth >= cutoff` → executor.
   *  Default 1 (root spawns keep today's unrestricted behaviour; any
   *  spawn made THROUGH an orchestrator defaults to executor). Tune
   *  this up (e.g. to a large number) to restore the old permissive
   *  behaviour for existing deep spawns wholesale. */
  defaultRoleDepthCutoff?: number
  /** Trust-boundary cap on pack-carried roles (see `role-registry.ts`'s
   *  `loadRoleRegistry`): a role pack whose `toolPolicy.delegation` is
   *  `"allow"` at a level ABOVE this cap has it forced to `"deny"` —
   *  the pack can still declare the intent, the daemon just refuses to
   *  grant it. Lets an operator install third-party role packs without
   *  trusting every one of them to self-grant delegation. Undefined
   *  (default) ⇒ no cap, any pack-declared level may carry
   *  `delegation: "allow"` (back-compat: #214 had no such knob). */
  maxGrantableDelegation?: number
  /** Default per-session Langfuse tracing opt-in when an `agent_start` call
   *  omits `trace`. Default false — sessions trace only when they opt in or
   *  this is on. See `filterSessionObserver` / `SpawnAgentInput.trace`. */
  langfuseTracing?: boolean
  /** Redactor slug applied to traced session content before it's sent to
   *  Langfuse (see `@agentproto/redaction`'s registry). Default "secrets"
   *  (deny-list by key + value-scan for secret shapes). */
  traceRedactor?: string
}

export interface ResolveSpawnDefaultsInput {
  /** Explicit-call `skills`. Undefined ⇒ caller expressed no preference,
   *  fall through to the config union. Provided ⇒ replaces it outright. */
  skills?: string[]
  /** Explicit-call AIP-45 `options` map — wins per-key over both the
   *  global and per-adapter config defaults. */
  options?: Record<string, boolean | number | string>
}

export interface ResolvedSpawnDefaults {
  skills: string[]
  options: Record<string, boolean | number | string>
}

export function resolveSpawnDefaults(
  defaults: SpawnDefaultsConfig | undefined,
  adapterSlug: string,
  input: ResolveSpawnDefaultsInput,
): ResolvedSpawnDefaults {
  const adapterDefaults = defaults?.adapters?.[adapterSlug]

  const options: Record<string, boolean | number | string> = {
    ...defaults?.options,
    ...adapterDefaults?.options,
    ...input.options,
  }

  const skills =
    input.skills !== undefined
      ? input.skills
      : Array.from(
          new Set([...(defaults?.skills ?? []), ...(adapterDefaults?.skills ?? [])]),
        )

  return { skills, options }
}

/** Manifest-declared AIP-45 option id + type, the minimum an adapter
 *  resolver needs to expose for `normalizeSkillsOption` below. Mirrors
 *  `AgentCliOption`'s `id`/`type` fields without importing
 *  `@agentproto/driver-agent-cli` into the runtime package. */
export interface DeclaredAdapterOption {
  id: string
  type: "boolean" | "integer" | "string" | "enum"
}

/**
 * Fold the resolved `skills` list into `options.skills` using whatever
 * shape the adapter's manifest declares for that option id (today, only
 * `type: "string"` exists for a skills-shaped option — e.g. hermes'
 * comma-joined `--skills a,b`). Adapters with no declared `skills` option
 * (e.g. claude-code, which auto-discovers from `~/.claude/skills`) are a
 * documented no-op — the effective skills list has nowhere to go, so it's
 * dropped rather than guessing a flag the manifest didn't declare.
 *
 * An `options.skills` already present (from config defaults or the
 * explicit call) is respected as-is and never overwritten here.
 */
export function normalizeSkillsOption(
  skills: string[],
  options: Record<string, boolean | number | string>,
  declaredOptions: readonly DeclaredAdapterOption[] | undefined,
): Record<string, boolean | number | string> {
  if (skills.length === 0 || "skills" in options) return options
  const skillsOption = declaredOptions?.find(o => o.id === "skills")
  if (!skillsOption || skillsOption.type !== "string") return options
  return { ...options, skills: skills.join(",") }
}
