import { createDoctype } from "@agentproto/doctype"
import type {
  DefineOperatorOptions,
  LegacyGovernance,
  LegacyMemory,
  OperatorDefinition,
  OperatorHandle,
  OperatorRoleBinding,
  OperatorWarning,
} from "./types.js"

/**
 * AIP-9 id pattern: `^[a-z][a-z0-9-]*[a-z0-9]$` (slug-style, no dots,
 * no underscores, 2+ chars). Stricter than the createDoctype default
 * because operator ids double as dispatch slugs in conversation
 * mentions (`@<slug>`) where dot/underscore would collide with
 * shell/file conventions.
 */
const OPERATOR_ID_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/
const POLICY_REF_PATTERN = /^policy:[A-Za-z0-9_./-]+$/
const AUDIT_REF_PATTERN = /^audit:[A-Za-z0-9_./-]+$/
const SLUG_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/
const KEBAB_PATTERN = /^[a-z][a-z0-9-]*$/

const LEGACY_AUTONOMY = { gated: 0, supervised: 5, autonomous: 10 } as const

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** A memory object in the deprecated `{kind, policy, share_with, external}` form. */
export function isLegacyMemory(v: unknown): v is LegacyMemory {
  return (
    isRecord(v) &&
    ("kind" in v || "policy" in v || "share_with" in v || "external" in v)
  )
}

/** A governance object in the deprecated inline `{policies, audit_log, autonomy}` form. */
export function isLegacyGovernance(v: unknown): v is LegacyGovernance {
  return (
    isRecord(v) && ("audit_log" in v || "autonomy" in v || "policies" in v)
  )
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

const own = <T>(value: T): T => deepFreeze(structuredClone(value))

/**
 * Resolve the operator's role (AIP-9 §Alias period). `role` wins. Without it,
 * `metadata.roleSlug` is read, then `profile.role` only when it is a role slug
 * the host says resolves. Nothing else is ever read as a role: no prose, no
 * default. When nothing resolves the result is `role_missing`.
 */
function resolveRoleBinding(
  def: OperatorDefinition,
  options: DefineOperatorOptions,
): { role?: OperatorRoleBinding; warning?: OperatorWarning } {
  if (def.role !== undefined) {
    return { role: typeof def.role === "string" ? { ref: def.role } : def.role }
  }
  const roleSlug = def.metadata?.roleSlug
  if (typeof roleSlug === "string" && roleSlug.length > 0) {
    return {
      role: { ref: roleSlug },
      warning: {
        code: "role_fallback",
        source: "metadata.roleSlug",
        role: roleSlug,
        message: `role is absent: read metadata.roleSlug '${roleSlug}'`,
      },
    }
  }
  const prose = def.profile?.role
  if (
    typeof prose === "string" &&
    SLUG_PATTERN.test(prose) &&
    options.roleExists?.(prose) === true
  ) {
    return {
      role: { ref: prose },
      warning: {
        code: "role_fallback",
        source: "profile.role",
        role: prose,
        message: `role is absent: read profile.role '${prose}', a role slug that resolves`,
      },
    }
  }
  return {
    warning: {
      code: "role_missing",
      message:
        "the operator has no role: role is absent and neither metadata.roleSlug nor a resolving profile.role gives one",
    },
  }
}

function legacyMemoryToAgent(m: LegacyMemory): Record<string, unknown> {
  switch (m.kind) {
    case "none":
      return { enabled: false }
    case "thread":
      return { scope: "per-thread" }
    case "external":
      return { store: m.external?.uri }
    default:
      return {}
  }
}

function fail(def: OperatorDefinition, detail: string): never {
  throw new Error(`defineOperator (AIP-9): id='${def.id}' ${detail}`)
}

function validateDefinition(def: OperatorDefinition): void {
  if (typeof def.name !== "string" || def.name.length === 0 || def.name.length > 80) {
    fail(def, "name must be 1 to 80 chars")
  }
  if (def.version !== undefined && !VERSION_PATTERN.test(def.version)) {
    fail(def, `version must match ${VERSION_PATTERN}`)
  }
  if (def.reports_to !== undefined && !SLUG_PATTERN.test(def.reports_to)) {
    fail(def, `reports_to must match ${SLUG_PATTERN}`)
  }

  const role = def.role
  if (role !== undefined) {
    const ref = typeof role === "string" ? role : role?.ref
    if (typeof ref !== "string" || ref.length === 0) {
      fail(def, "role must be a non-empty ref or an object with a non-empty ref")
    }
    if (typeof role !== "string") {
      for (const [k, v] of Object.entries(role.with ?? {})) {
        if (!["string", "number", "boolean"].includes(typeof v)) {
          fail(def, `role.with.${k} must be a string, number or boolean`)
        }
      }
    }
  }

  if (def.profile) {
    const { role: prose, voice, boundaries } = def.profile
    for (const [k, v] of [["role", prose], ["voice", voice]] as const) {
      if (v !== undefined && (typeof v !== "string" || v.length === 0 || v.length > 1000)) {
        fail(def, `profile.${k} must be 1 to 1000 chars`)
      }
    }
    if (boundaries !== undefined && !Array.isArray(boundaries)) {
      fail(def, "profile.boundaries must be an array")
    }
  }

  if (def.autonomy !== undefined) {
    if (typeof def.autonomy !== "number" || def.autonomy < 0 || def.autonomy > 10) {
      fail(def, "autonomy must be a number from 0 to 10")
    }
  }

  if (isLegacyMemory(def.memory)) {
    if (def.memory.kind === "external" && !def.memory.external?.uri) {
      fail(def, "memory.kind='external' requires memory.external.uri")
    }
    for (const peer of def.memory.share_with ?? []) {
      if (!SLUG_PATTERN.test(peer)) {
        fail(def, `memory.share_with entry '${peer}' must match ${SLUG_PATTERN}`)
      }
    }
  }

  if (isLegacyGovernance(def.governance)) {
    if (!AUDIT_REF_PATTERN.test(def.governance.audit_log ?? "")) {
      fail(def, `governance.audit_log must match ${AUDIT_REF_PATTERN}`)
    }
    for (const p of def.governance.policies ?? []) {
      if (!POLICY_REF_PATTERN.test(p)) {
        fail(def, `governance.policies entry '${p}' must match ${POLICY_REF_PATTERN}`)
      }
    }
  }

  for (const c of def.capabilities ?? []) {
    if (!KEBAB_PATTERN.test(c)) fail(def, `capabilities entry '${c}' must match ${KEBAB_PATTERN}`)
  }
  for (const t of def.tags ?? []) {
    if (!KEBAB_PATTERN.test(t)) fail(def, `tags entry '${t}' must match ${KEBAB_PATTERN}`)
  }

  // A gated operator (autonomy 0, or the deprecated governance.autonomy 'gated')
  // is never proactive. The default participation mode is mention-only.
  const mode = def.participation?.mode ?? "mention-only"
  if (mode !== "mention-only" && mode !== "silent") {
    if (isLegacyGovernance(def.governance) && def.governance.autonomy === "gated") {
      fail(
        def,
        `governance.autonomy='gated' forbids participation.mode='${mode}' (must be 'mention-only' or 'silent')`,
      )
    }
    if (def.autonomy === 0) {
      fail(
        def,
        `autonomy=0 forbids participation.mode='${mode}' (must be 'mention-only' or 'silent')`,
      )
    }
  }

  if (def.runtime?.kind === "agent-cli" && !def.runtime.ref) {
    fail(
      def,
      "runtime.kind='agent-cli' requires runtime.ref (e.g. '@agentproto/adapter-hermes#hermes')",
    )
  }
}

function buildHandle(
  def: OperatorDefinition,
  options: DefineOperatorOptions,
): OperatorHandle {
  const warnings: OperatorWarning[] = []
  const deprecated = (field: string, message: string) =>
    warnings.push({ code: "operator_field_deprecated", field, message })

  const { role, warning } = resolveRoleBinding(def, options)
  if (warning) warnings.push(warning)

  let home = def.home
  if (def.company !== undefined) {
    if (home === undefined) {
      home = def.company
      deprecated("company", "company is deprecated: read as home")
    } else {
      deprecated("company", "company is deprecated and ignored: home is set")
    }
  }

  let persona = def.persona
  if (def.profile?.voice !== undefined) {
    if (persona === undefined) {
      persona = { inline: { voice: def.profile.voice } }
      deprecated("profile.voice", "profile.voice is deprecated: folded into an inline persona")
    } else {
      deprecated("profile.voice", "profile.voice is deprecated and ignored: persona is set")
    }
  }

  const boundaries = [...(def.boundaries ?? [])]
  if (def.profile?.boundaries !== undefined) {
    deprecated("profile.boundaries", "profile.boundaries is deprecated: folded into boundaries")
    for (const b of def.profile.boundaries) if (!boundaries.includes(b)) boundaries.push(b)
  }

  let autonomy = def.autonomy
  const legacyGovernance = isLegacyGovernance(def.governance) ? def.governance : undefined
  if (legacyGovernance) {
    deprecated(
      "governance",
      "the inline governance object is deprecated: policies go to policy, autonomy to autonomy",
    )
    autonomy ??= LEGACY_AUTONOMY[legacyGovernance.autonomy]
  }

  let memory = isLegacyMemory(def.memory) ? undefined : def.memory
  const legacyMemory = isLegacyMemory(def.memory) ? def.memory : undefined
  if (legacyMemory) {
    deprecated("memory", `memory.kind '${legacyMemory.kind}' is deprecated: mapped onto the AGENT memory config`)
    memory = legacyMemoryToAgent(legacyMemory) as typeof memory
    if (legacyMemory.share_with?.length) {
      deprecated("memory.share_with", "memory.share_with is deprecated toward AIP-38 read grants")
    }
  }

  if (def.runtime?.session) {
    deprecated("runtime.session", "runtime.session is deprecated: session lifetime belongs to AIP-46 and the host")
  }

  const handle: Record<string, unknown> = {
    id: def.id,
    name: def.name,
    persona_summary: def.persona_summary,
    version: def.version,
    description: def.description,
    entry: def.entry,
    role,
    home,
    reports_to: def.reports_to,
    extends: def.extends,
    model: def.model,
    identity: def.identity,
    persona,
    runner: def.runner,
    actions: def.actions,
    workflows: def.workflows,
    routines: def.routines,
    delegates_to: def.delegates_to,
    policy: def.policy,
    traits: def.traits,
    autonomy,
    on: def.on,
    publish: def.publish,
    skills: def.skills ?? [],
    tools: def.tools ?? [],
    memory,
    governance: legacyGovernance ? undefined : def.governance,
    boundaries,
    profile: def.profile?.role !== undefined ? { role: def.profile.role } : undefined,
    capabilities: def.capabilities ?? [],
    participation: {
      mode: def.participation?.mode ?? "mention-only",
      pass_when: def.participation?.pass_when,
      reactions: def.participation?.reactions ?? false,
    },
    runtime: def.runtime,
    tags: def.tags ?? [],
    metadata: def.metadata ?? {},
    legacy:
      legacyMemory || legacyGovernance
        ? { memory: legacyMemory, governance: legacyGovernance }
        : undefined,
    warnings,
  }
  for (const key of Object.keys(handle)) {
    if (handle[key] === undefined) delete handle[key]
  }
  return own(handle) as unknown as OperatorHandle
}

/**
 * AIP-9 reference implementation of `defineOperator`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern, top-level
 * freeze, "defineOperator (AIP-9): …" error prefix) run uniformly with every
 * other AIP defineX. The AGENT fields are passed through as they are; the
 * deprecated forms are accepted and folded with an `operator_field_deprecated`
 * warning. Without `role`, the alias period applies: `role_fallback` or
 * `role_missing` (never a default role), recorded in `handle.warnings`.
 */
export function defineOperator(
  def: OperatorDefinition,
  options: DefineOperatorOptions = {},
): OperatorHandle {
  return createDoctype<OperatorDefinition, OperatorHandle>({
    aip: 9,
    name: "operator",
    idPattern: OPERATOR_ID_PATTERN,
    // OPERATOR.md has no `description` requirement: persona_summary is the
    // LLM-facing one-liner, capped at 280 per the schema.
    readDescription: (d) => d.persona_summary,
    maxDescriptionLen: 280,
    validate: validateDefinition,
    build: (d) => buildHandle(d, options),
  })(def)
}
