import type { ToolHandle } from "@agentproto/tool"
import type {
  ImplementsEntry,
  DriverHandle,
  ResolverContext,
  ResolverResult,
} from "./types.js"
import { normalizeToolId } from "./define-provider.js"

const KIND_PREFERENCE: readonly string[] = [
  "builtin",
  "sdk",
  "http",
  "mcp",
  "cli",
]

/**
 * AIP-30 6-phase resolver. Picks one provider per call.
 *
 * Algorithm summary (full description in AIP-30 § Multi-provider routing):
 *
 *  Phase 1 — Candidate set: filter providers implementing(tool.id) and
 *           respecting tool.driverConstraints (forbid / requireKind)
 *           and per-call schema_narrowing compatibility.
 *  Phase 2 — Capability gate: drop providers with failed install /
 *           version_check or stale failed health_check.
 *  Phase 3 — Policy filter: drop providers violating policy_tags
 *           allowlist or missing region match.
 *  Phase 4 — Pin override: if context.pinnedProvider, return it or fail.
 *  Phase 5 — Cost / preference rank: default_driver first, else by
 *           cost_units_per_call → kind preference → recency → lex(id).
 *  Phase 6 — Bind: return { provider, implementsEntry }.
 */
export function resolveDriver(args: {
  tool: ToolHandle
  candidates: readonly DriverHandle[]
  context: ResolverContext
  /** Inputs the call is using; used in narrowing compatibility check. */
  inputKeys?: readonly string[]
  /** Per-provider availability (capability gate from Phase 2). */
  availability?: Map<string, DriverAvailability>
}): ResolverResult {
  const { tool, candidates, context } = args
  const inputKeys = args.inputKeys ?? []
  const availability = args.availability ?? new Map()
  const rejected: Array<{ providerId: string; phase: number; reason: string }> = []

  // Phase 1 — Candidate set.
  const phase1: Array<{ provider: DriverHandle; entry: ImplementsEntry }> = []
  for (const provider of candidates) {
    const entry = findImplementsEntry(provider, tool)
    if (!entry) {
      rejected.push({ providerId: provider.id, phase: 1, reason: "tool_not_implemented" })
      continue
    }
    if (tool.driverConstraints.forbid.includes(provider.kind)) {
      rejected.push({ providerId: provider.id, phase: 1, reason: "kind_forbidden_by_contract" })
      continue
    }
    if (
      tool.driverConstraints.requireKind.length > 0 &&
      !tool.driverConstraints.requireKind.includes(provider.kind)
    ) {
      rejected.push({ providerId: provider.id, phase: 1, reason: "kind_not_in_required_kinds" })
      continue
    }
    // Schema-narrowing compatibility: if the call uses an input the
    // provider drops, refuse. The host SHOULD surface this as
    // `input_unsupported` to the caller; the resolver simply filters.
    const dropped = entry.schemaNarrowing?.dropInputs ?? []
    const usesDropped = inputKeys.find(k => dropped.includes(k))
    if (usesDropped) {
      rejected.push({
        providerId: provider.id,
        phase: 1,
        reason: `input_unsupported:${usesDropped}`,
      })
      continue
    }
    phase1.push({ provider, entry })
  }

  // Phase 2 — Capability gate.
  const phase2 = phase1.filter(({ provider }) => {
    const a = availability.get(provider.id)
    if (!a) return true // unknown availability = assume available
    if (a.installFailed) {
      rejected.push({ providerId: provider.id, phase: 2, reason: "install_failed" })
      return false
    }
    if (a.versionMismatch) {
      rejected.push({ providerId: provider.id, phase: 2, reason: "version_mismatch" })
      return false
    }
    if (a.authState === "unauthed" || a.authState === "expired") {
      rejected.push({ providerId: provider.id, phase: 2, reason: `auth_state:${a.authState}` })
      return false
    }
    if (a.healthCheckFailedRecently) {
      rejected.push({ providerId: provider.id, phase: 2, reason: "health_check_failed_recently" })
      return false
    }
    return true
  })

  // Phase 3 — Policy filter.
  const phase3 = phase2.filter(({ provider }) => {
    if (
      context.policyForbiddenTags &&
      provider.policyTags.some(t => context.policyForbiddenTags!.includes(t))
    ) {
      rejected.push({ providerId: provider.id, phase: 3, reason: "policy_tag_forbidden" })
      return false
    }
    if (context.policyAllowedTags && context.policyAllowedTags.length > 0) {
      const allowed = provider.policyTags.some(t =>
        context.policyAllowedTags!.includes(t)
      )
      if (!allowed) {
        rejected.push({ providerId: provider.id, phase: 3, reason: "policy_tag_not_in_allowlist" })
        return false
      }
    }
    if (context.regionConstraint) {
      const matches =
        provider.region.includes(context.regionConstraint) ||
        provider.region.includes("global")
      if (!matches) {
        rejected.push({
          providerId: provider.id,
          phase: 3,
          reason: `region_mismatch:wanted=${context.regionConstraint},have=${provider.region.join("|")}`,
        })
        return false
      }
    }
    return true
  })

  // Phase 4 — Pin override.
  if (context.pinnedProvider) {
    const pinned = phase3.find(({ provider }) => provider.id === context.pinnedProvider)
    if (pinned) {
      return { ok: true, provider: pinned.provider, implementsEntry: pinned.entry }
    }
    return {
      ok: false,
      error: {
        code: "pinned_provider_unavailable",
        message: `Pinned provider '${context.pinnedProvider}' was filtered by an earlier resolver phase.`,
        rejected,
      },
    }
  }

  // Phase 5 — Cost / preference rank.
  if (phase3.length === 0) {
    const code = inferNoRouteCode(rejected, context)
    return {
      ok: false,
      error: {
        code,
        message: `No provider survived resolver filters for tool '${tool.id}'.`,
        rejected,
      },
    }
  }

  // default_driver preference.
  if (tool.defaultDriver) {
    const def = phase3.find(({ provider }) => provider.id === tool.defaultDriver)
    if (def) {
      return { ok: true, provider: def.provider, implementsEntry: def.entry }
    }
  }

  // Cost ranking.
  const ranked = [...phase3].sort((a, b) => {
    const costA = a.entry.costOverride?.costUnitsPerCall ??
      a.provider.costOverride?.costUnitsPerCall ?? Number.POSITIVE_INFINITY
    const costB = b.entry.costOverride?.costUnitsPerCall ??
      b.provider.costOverride?.costUnitsPerCall ?? Number.POSITIVE_INFINITY
    if (costA !== costB) return costA - costB
    const kindA = KIND_PREFERENCE.indexOf(a.provider.kind)
    const kindB = KIND_PREFERENCE.indexOf(b.provider.kind)
    if (kindA !== kindB) return kindA - kindB
    return a.provider.id.localeCompare(b.provider.id)
  })

  const winner = ranked[0]!
  return { ok: true, provider: winner.provider, implementsEntry: winner.entry }
}

export interface DriverAvailability {
  installFailed?: boolean
  versionMismatch?: boolean
  authState?: "unknown" | "unauthed" | "authed" | "expired"
  healthCheckFailedRecently?: boolean
  /** Last successful health-check timestamp, ISO-8601. */
  lastHealthOk?: string
}

function findImplementsEntry(
  provider: DriverHandle,
  tool: ToolHandle
): ImplementsEntry | undefined {
  return provider.implements.find(e => normalizeToolId(e.tool) === tool.id)
}

function inferNoRouteCode(
  rejected: ReadonlyArray<{ phase: number; reason: string }>,
  context: ResolverContext
): "no_route" | "policy_violation" | "region_mismatch" {
  if (rejected.length === 0) return "no_route"
  const reasons = rejected.map(r => r.reason)
  if (
    context.regionConstraint &&
    reasons.some(r => r.startsWith("region_mismatch"))
  ) {
    return "region_mismatch"
  }
  if (reasons.some(r => r.startsWith("policy_tag"))) {
    return "policy_violation"
  }
  return "no_route"
}
