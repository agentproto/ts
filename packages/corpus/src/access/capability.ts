/**
 * Capability — uniform tool-boundary enforcement.
 *
 * Every corpus tool declares a required `Capability`. The host
 * (Guilde corpus.bundle / corpus-cli) calls `evaluateCapability` at
 * dispatch time. Capabilities are configured per-workspace under
 * `KNOWLEDGE.md.metadata.corpus.accessModes`.
 *
 * Pure logic. Audit + actual rejection happen in the host.
 */

export type Capability =
  | "read"
  | "cite"
  | "flag-learning"
  | "curate"
  | "promote"
  | "activate-playbook"
  | "admin-reindex"
  | "bypass-default-filters"

export interface CapabilityRule {
  readonly allowedRoles: readonly string[]
  /** Optional rate-limit hint — enforcement lives in the host. */
  readonly rateLimit?: {
    readonly perOperator?: number
    readonly window?: string
  }
  /** Requires curator approval before the action commits. */
  readonly requireApproval?: boolean
  /** Audit-log the call (default false). */
  readonly audit?: boolean
}

export type AccessModesMap = Readonly<
  Partial<Record<Capability, CapabilityRule>>
>

export interface CapabilityCaller {
  /** identityTree most-specific → least-specific. */
  readonly identityTree: readonly string[]
}

export interface CapabilityDecision {
  readonly permitted: boolean
  readonly reason: string
  /** Rate-limit hint to enforce, if defined. */
  readonly rateLimit?: CapabilityRule["rateLimit"]
  /** True if the tool MUST collect approval before committing. */
  readonly requireApproval: boolean
  /** True if the host should write an audit entry on completion. */
  readonly audit: boolean
}

/**
 * Sensible defaults applied when KNOWLEDGE.md doesn't declare a rule
 * for a given capability. Match the v1 plan's accessModes shape:
 *
 *   read | cite | flag-learning  →  allowedRoles: ["*"]   (anyone)
 *   curate | promote             →  allowedRoles: ["corpus-curator", "admin"]
 *   activate-playbook            →  same + requireApproval: true
 *   admin-reindex                →  allowedRoles: ["admin"]
 *   bypass-default-filters       →  curator/admin + audit: true
 */
const DEFAULT_RULES: Record<Capability, CapabilityRule> = Object.freeze({
  "read": { allowedRoles: ["*"] },
  "cite": { allowedRoles: ["*"] },
  "flag-learning": {
    allowedRoles: ["*"],
    rateLimit: { perOperator: 20, window: "24h" },
  },
  "curate": { allowedRoles: ["corpus-curator", "admin"] },
  "promote": { allowedRoles: ["corpus-curator", "admin"] },
  "activate-playbook": {
    allowedRoles: ["corpus-curator", "admin"],
    requireApproval: true,
  },
  "admin-reindex": { allowedRoles: ["admin"] },
  "bypass-default-filters": {
    allowedRoles: ["corpus-curator", "admin"],
    audit: true,
  },
})

export function evaluateCapability(
  capability: Capability,
  accessModes: AccessModesMap | undefined,
  caller: CapabilityCaller
): CapabilityDecision {
  const rule = accessModes?.[capability] ?? DEFAULT_RULES[capability]
  if (!rule) {
    return {
      permitted: false,
      reason: `unknown capability "${capability}"`,
      requireApproval: false,
      audit: true,
    }
  }
  const permitted = matchesRoles(rule.allowedRoles, caller.identityTree)
  return {
    permitted,
    reason: permitted
      ? `caller identity matches allowedRoles for "${capability}"`
      : `caller identity does NOT match allowedRoles for "${capability}"`,
    rateLimit: rule.rateLimit,
    requireApproval: !!rule.requireApproval,
    audit: !!rule.audit,
  }
}

function matchesRoles(
  allowed: readonly string[],
  identityTree: readonly string[]
): boolean {
  if (allowed.includes("*")) return true
  for (const role of allowed) {
    // Accept both bare slugs and full ws:// refs in the rule.
    const expanded = role.startsWith("ws://") ? role : `ws://roles/${role}`
    if (identityTree.includes(expanded)) return true
  }
  return false
}

/**
 * Read accessModes from a parsed KNOWLEDGE.md workspace
 * frontmatter. Returns undefined if not declared — caller uses
 * DEFAULT_RULES.
 */
export function readAccessModes(
  workspaceFrontmatter: Readonly<Record<string, unknown>>
): AccessModesMap | undefined {
  const meta = workspaceFrontmatter.metadata as
    | { corpus?: { accessModes?: unknown } }
    | undefined
  const am = meta?.corpus?.accessModes
  if (!am || typeof am !== "object") return undefined
  return am as AccessModesMap
}
