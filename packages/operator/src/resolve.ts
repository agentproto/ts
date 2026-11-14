/**
 * `resolveOperator`: AIP-9 §Resolution as a pure function.
 *
 * An operator handle and its body go in; an AGENT entry comes out, whose body
 * is the system prompt assembled in the merge-table order:
 *
 *   1. base AGENT (`extends` chain)      5. slot bindings block
 *   2. IDENTITY                          6. OPERATOR body and inline overrides
 *   3. PERSONA                           7. host definition sections, boundaries
 *   4. ROLE (after its own chain)
 *
 * Everything the operator references is read through the injected
 * `OperatorSources`; this module does no I/O, reads no clock and draws no
 * randomness, so the result is deterministic and cacheable on its `digest`.
 * What the host's turn composer adds per turn (live state, memory digest,
 * playbook overlays, participation rules, approvals brief, per-request tool
 * pick) is not part of the definition and is not produced here.
 */

import {
  composeInstructions,
  EXTENDS_MAX_DEPTH,
  type AgentDefinition,
  type AgentEntry,
  type AgentHandle,
  type AnyRef,
} from "@agentproto/agent"
import { PolicyGrantError, type GrantInput, type PolicyGrants } from "@agentproto/policy"
import { resolveRole, validateRoleBinding, type RoleHandle } from "@agentproto/role"
import { digestOf } from "./resolve-digest.js"
import {
  personaBoundaries,
  renderBindings,
  renderIdentity,
  renderPersona,
  renderRole,
} from "./resolve-render.js"
import { filterTools, type DeclaredTool } from "./resolve-tools.js"
import {
  OperatorResolutionError,
  ROLE_CHAIN_MAX,
  type IdentityEntry,
  type OperatorEntry,
  type OperatorSources,
  type PersonaEntry,
  type ResolutionIssue,
  type ResolutionWarning,
  type ResolvedOperator,
} from "./resolve-types.js"
import type { OperatorHandle, ToolRef } from "./types.js"

type Rec = Record<string, unknown>

/** The ref a loader receives: a string, or the `ref`/`file` of an object ref. */
function refKey(ref: AnyRef | undefined): string | undefined {
  if (ref === undefined) return undefined
  if (typeof ref === "string") return ref
  return ref.ref ?? ref.file
}

function inlineOf(ref: AnyRef | undefined): Rec | undefined {
  return typeof ref === "object" && ref !== null && refKey(ref) === undefined ? ref.inline : undefined
}

function fail(...issues: ResolutionIssue[]): never {
  throw new OperatorResolutionError(issues)
}

interface AgentLink {
  readonly id: string
  readonly agent: Rec
  readonly body?: string
}

/** Walks `operator.extends`. At most EXTENDS_MAX_DEPTH parents; a repeated id is a cycle. */
async function loadAgentChain(operator: OperatorHandle, sources: OperatorSources): Promise<AgentLink[]> {
  const parents: AgentLink[] = []
  const seen = new Set<string>([operator.id])
  let next: AnyRef | undefined = operator.extends
  while (next !== undefined) {
    if (parents.length >= EXTENDS_MAX_DEPTH) {
      fail({
        code: "agent_chain_too_deep",
        subject: refKey(next),
        message: `the agent extends chain of '${operator.id}' is longer than ${EXTENDS_MAX_DEPTH} (AIP-42)`,
      })
    }
    const inline = inlineOf(next)
    if (inline) {
      parents.push({ id: `inline:${parents.length}`, agent: inline })
      break
    }
    const key = refKey(next)
    const entry: AgentEntry | null | undefined = key === undefined ? null : await sources.agent?.(key)
    if (!entry) {
      fail({ code: "agent_unresolvable", subject: key, message: `base agent '${key ?? "?"}' did not resolve` })
    }
    if (seen.has(entry.agent.id)) {
      fail({
        code: "agent_chain_cycle",
        subject: entry.agent.id,
        message: `the agent extends chain of '${operator.id}' repeats '${entry.agent.id}'`,
      })
    }
    seen.add(entry.agent.id)
    parents.push({ id: entry.agent.id, agent: entry.agent as unknown as Rec, body: entry.body })
    next = entry.agent.extends
  }
  return parents
}

const UNION_LISTS = ["skills", "workflows", "routines", "delegates_to", "boundaries", "tags"] as const
const OBJECT_MERGES = ["traits", "metadata", "on", "publish"] as const

function dedupe<T>(items: readonly T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = JSON.stringify(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** Child over parent: scalars the child sets win, lists are unioned, small objects merge by key. */
function mergeOver(base: Rec, over: Rec): Rec {
  const out: Rec = { ...base }
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined || key === "tools") continue
    if ((UNION_LISTS as readonly string[]).includes(key)) {
      out[key] = dedupe([...((base[key] as unknown[] | undefined) ?? []), ...(value as unknown[])])
    } else if ((OBJECT_MERGES as readonly string[]).includes(key)) {
      out[key] = { ...(base[key] as Rec | undefined), ...(value as Rec) }
    } else if (key === "memory") {
      const b = (base.memory as Rec | undefined) ?? {}
      const o = value as Rec
      const anchors = dedupe([...((b.anchors as string[] | undefined) ?? []), ...((o.anchors as string[] | undefined) ?? [])])
      out.memory = { ...b, ...o, ...(anchors.length > 0 ? { anchors } : {}) }
    } else if (key === "actions") {
      const b = (base.actions as Rec | undefined) ?? {}
      const granted = dedupe([
        ...((b.granted as unknown[] | undefined) ?? []),
        ...(((value as Rec).granted as unknown[] | undefined) ?? []),
      ])
      out.actions = { ...b, ...(value as Rec), ...(granted.length > 0 ? { granted } : {}) }
    } else {
      out[key] = value
    }
  }
  return out
}

/** The fields an operator contributes to the AGENT merge (not its role, home, participation, runtime). */
function operatorAsAgent(op: OperatorHandle): Rec {
  const pick: Rec = {
    version: op.version,
    description: op.description,
    model: op.model,
    identity: op.identity,
    persona: op.persona,
    runner: op.runner,
    actions: op.actions,
    workflows: op.workflows,
    routines: op.routines,
    delegates_to: op.delegates_to,
    policy: op.policy,
    traits: op.traits,
    autonomy: op.autonomy,
    on: op.on,
    publish: op.publish,
    memory: op.memory,
    governance: op.governance,
    skills: op.skills.map(s => (typeof s === "object" && "id" in s ? { ref: s.id } : s)),
    boundaries: op.boundaries,
    tags: op.tags,
    metadata: op.metadata,
  }
  return Object.fromEntries(Object.entries(pick).filter(([, v]) => v !== undefined))
}

async function loadIdentity(ref: AnyRef, sources: OperatorSources): Promise<IdentityEntry> {
  const inline = inlineOf(ref)
  if (inline) return { identity: inline as unknown as IdentityEntry["identity"] }
  const key = refKey(ref)
  const entry = key === undefined ? null : await sources.identity?.(key)
  return entry ?? fail({ code: "identity_unresolvable", subject: key, message: `identity '${key ?? "?"}' did not resolve` })
}

async function loadPersona(ref: AnyRef, sources: OperatorSources): Promise<PersonaEntry> {
  const inline = inlineOf(ref)
  if (inline) return { persona: inline as unknown as PersonaEntry["persona"] }
  const key = refKey(ref)
  const entry = key === undefined ? null : await sources.persona?.(key)
  return entry ?? fail({ code: "persona_unresolvable", subject: key, message: `persona '${key ?? "?"}' did not resolve` })
}

async function loadPolicy(ref: AnyRef, sources: OperatorSources): Promise<PolicyGrants> {
  const inline = inlineOf(ref)
  if (inline) return inline as PolicyGrants
  const key = refKey(ref)
  const policy = key === undefined ? null : await sources.policy?.(key)
  return policy ?? fail({ code: "policy_unresolvable", subject: key, message: `policy '${key ?? "?"}' did not resolve` })
}

interface ResolvedRoleParts {
  readonly role: RoleHandle
  readonly body: string
  readonly chain: readonly string[]
  readonly warnings: ResolutionWarning[]
}

async function loadRole(ref: string, sources: OperatorSources): Promise<ResolvedRoleParts> {
  let resolved: Awaited<ReturnType<typeof resolveRole>>
  try {
    // maxDepth counts parent hops: 7 hops is the 8-role chain AIP-47 allows.
    resolved = await resolveRole(ref, { sources: sources.roles ?? [], maxDepth: ROLE_CHAIN_MAX - 1 })
  } catch {
    return fail({ code: "role_unresolvable", subject: ref, message: `role '${ref}' did not resolve in any role source` })
  }
  const warnings: ResolutionWarning[] = []
  for (const w of resolved.warnings) {
    if (w.code === "role_extends_depth_exceeded") {
      fail({
        code: "role_chain_too_deep",
        subject: ref,
        message: `the role extends chain of '${ref}' is longer than ${ROLE_CHAIN_MAX} (AIP-47)`,
      })
    }
    if (w.code === "role_extends_cycle") {
      fail({ code: "role_chain_cycle", subject: ref, message: `the role extends chain of '${ref}' has a cycle` })
    }
    if (w.code === "role_extends_missing" || w.code === "role_validation_failed") {
      warnings.push({ code: w.code, subject: ref, message: w.message })
    }
  }
  return { role: resolved.role, body: resolved.body, chain: resolved.chain, warnings }
}

/**
 * Resolve an operator into an AGENT entry. Throws `OperatorResolutionError`
 * when the operator cannot be resolved: a referenced template the loader does
 * not return, a chain over its limit, a role binding the role rejects, or a
 * tool the operator declares but its policy does not grant.
 */
export async function resolveOperator(entry: OperatorEntry, sources: OperatorSources = {}): Promise<ResolvedOperator> {
  const { operator } = entry
  const warnings: ResolutionWarning[] = operator.warnings.map(w => ({ code: w.code, message: w.message }))
  const issues: ResolutionIssue[] = []

  // 1. base AGENT chain, root first.
  const parents = await loadAgentChain(operator, sources)
  const chainRoot = [...parents].reverse()
  let merged: Rec = {}
  for (const link of chainRoot) merged = mergeOver(merged, link.agent)
  merged = mergeOver(merged, operatorAsAgent(operator))

  // 2, 3. identity and persona: the operator's own ref overrides the chain's.
  const identity = merged.identity === undefined ? undefined : await loadIdentity(merged.identity as AnyRef, sources)
  const persona = merged.persona === undefined ? undefined : await loadPersona(merged.persona as AnyRef, sources)

  // 4, 5. role and slot bindings.
  const roleRef = operator.role
  const role = roleRef ? await loadRole(roleRef.ref, sources) : undefined
  warnings.push(...(role?.warnings ?? []))
  const roleSkills: { name: string; body: string }[] = []
  const slotTools: DeclaredTool[] = []
  if (role && roleRef) {
    const slots = role.role.slots ?? {}
    const verdict = validateRoleBinding(
      slots,
      { bind: roleRef.bind, with: roleRef.with },
      sources.refResolves ? { refResolves: sources.refResolves } : {},
    )
    for (const e of verdict.errors) issues.push({ code: "role_binding_invalid", subject: e.slot, message: `${e.code}: ${e.message}` })
    for (const w of verdict.warnings) warnings.push({ code: w.code, subject: w.slot, message: w.message })
    for (const [name, slot] of Object.entries(slots)) {
      const value = roleRef.bind?.[name]
      if ("tool" in slot && value !== undefined) slotTools.push({ origin: "slot", item: value as ToolRef })
    }
    for (const skillRef of role.role.skills ?? []) {
      const loaded = await sources.skill?.(skillRef)
      if (!loaded) {
        fail({ code: "skill_unresolvable", subject: skillRef, message: `role skill '${skillRef}' did not resolve` })
      }
      roleSkills.push({ name: loaded.skill.name, body: loaded.body })
    }
  }

  // The effective policy: the operator's (or inherited) policy composed with the node-chain policies.
  let policyInputs: GrantInput[] = [...(sources.chainPolicies ?? [])]
  const effectivePolicy = merged.policy === undefined ? undefined : await loadPolicy(merged.policy as AnyRef, sources)
  if (effectivePolicy) policyInputs = [effectivePolicy, ...policyInputs]

  // Tools: union of the agent chain, role intent, slot-bound and operator tools, filtered by policy.
  const declared: DeclaredTool[] = [
    ...chainRoot.flatMap(l => ((l.agent.tools as ToolRef[] | undefined) ?? []).map(item => ({ origin: "agent" as const, item }))),
    ...slotTools,
    ...operator.tools.map(item => ({ origin: "operator" as const, item })),
  ]
  const principals = [`operator://${operator.id}`, `operator:${operator.id}`, ...(sources.principals ?? [])]
  let tools: ReturnType<typeof filterTools>
  try {
    tools = filterTools(declared, role?.role.tools ?? [], policyInputs, principals)
  } catch (e) {
    if (!(e instanceof PolicyGrantError)) throw e
    return fail({ code: "policy_invalid", message: `the effective policy of '${operator.id}' is malformed: ${e.message}` })
  }
  issues.push(...tools.refusals)
  warnings.push(...tools.warnings)

  // Autonomy: a gated operator (0) is never proactive.
  const autonomy = (merged.autonomy as number | undefined) ?? undefined
  if (autonomy === 0 && operator.participation.mode === "proactive") {
    issues.push({
      code: "autonomy_participation_conflict",
      message: `'${operator.id}' has autonomy 0 (gated) and participation.mode 'proactive'; a gated operator is mention-only or silent`,
    })
  }

  const model = merged.model ?? sources.defaultModel
  if (model === undefined) {
    issues.push({ code: "model_missing", message: `neither '${operator.id}' nor its base agents name a model, and the host supplies no default` })
  }

  if (issues.length > 0) throw new OperatorResolutionError(issues)

  // Body, in merge-table order.
  const bindings = role && roleRef ? renderBindings(role.role.slots, roleRef.bind, roleRef.with) : undefined
  const sections = [
    ...chainRoot.map(l => l.body?.trim()),
    identity ? renderIdentity(identity.identity, identity.body) : undefined,
    persona ? renderPersona(persona.persona, persona.body) : undefined,
    role ? renderRole(role.role, role.body, roleSkills) : undefined,
    bindings,
    entry.body?.trim(),
    ...(sources.hostSections ?? []).map(s => s.trim()),
  ].filter((s): s is string => typeof s === "string" && s.length > 0)

  const boundaries = dedupe([
    ...((merged.boundaries as string[] | undefined) ?? []),
    ...(persona ? personaBoundaries(persona.persona) : []),
    ...(role?.role.antiPatterns ?? []).map(a => `Out of scope for this role: ${a}`),
  ])

  // Memory is anchored on the operator (C4) unless it is disabled.
  const memory = merged.memory as AgentDefinition["memory"] | undefined
  const anchored =
    memory?.enabled === false
      ? memory
      : { ...memory, anchors: dedupe([...(memory?.anchors ?? []), `operator:${operator.id}`]) }

  const { tools: _tools, extends: _extends, ...rest } = merged
  const agent = {
    ...rest,
    schema: "agent/v1",
    id: operator.id,
    description: (merged.description as string | undefined) ?? operator.persona_summary,
    model,
    tools: [...tools.tools],
    ...(boundaries.length > 0 ? { boundaries } : {}),
    memory: anchored,
  } as unknown as AgentHandle

  const body = composeInstructions(agent, sections.join("\n\n"), { sectionOrder: ["body", "boundaries", "traits"] })

  const digest = digestOf({
    v: 1,
    operator: { handle: operator, body: entry.body ?? null },
    agents: chainRoot,
    identity: identity ?? null,
    persona: persona ?? null,
    role: role ? { role: role.role, body: role.body, chain: role.chain } : null,
    roleSkills,
    binding: { bind: roleRef?.bind ?? null, with: roleRef?.with ?? null },
    policy: policyInputs,
    hostSections: sources.hostSections ?? [],
    defaultModel: sources.defaultModel ?? null,
    principals,
  })

  return {
    agent,
    body,
    digest,
    warnings,
    knowledgePacks: role?.role.knowledge?.packs ?? [],
    roleChain: role?.chain ?? [],
    agentChain: [operator.id, ...parents.map(p => p.id)],
  }
}
