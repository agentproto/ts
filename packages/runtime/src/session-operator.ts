/**
 * AIP-46 §Operator binding: the daemon side of `Session.operator`.
 *
 * The daemon has no operator resolver (it only consumes effective AGENTs), so
 * "resolved at spawn" (rule 2) is enforced here as far as the daemon can know:
 * the ref must be a well formed AIP-54 `operator` ref. Whether that operator
 * exists is the composing host's check, made before it names the operator on
 * `agent_start`.
 */

const SLUG_RE = /^[a-z][a-z0-9_-]*$/
const WORKSPACE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/
const WS_PREFIX = "ws://operators/"
const COMPACT_PREFIX = "operator:"

/** Canonical compact form of a well formed operator ref, or undefined.
 *  `ws://operators/<slug>` rewrites to `operator:<slug>` and never gains a
 *  workspace suffix (AIP-54 tenant-scope asymmetry). A bare slug is not a ref. */
export function canonicalOperatorRef(raw: string): string | undefined {
  if (raw.startsWith(WS_PREFIX)) {
    const slug = raw.slice(WS_PREFIX.length)
    return SLUG_RE.test(slug) ? `${COMPACT_PREFIX}${slug}` : undefined
  }
  if (!raw.startsWith(COMPACT_PREFIX)) return undefined
  const body = raw.slice(COMPACT_PREFIX.length)
  const at = body.indexOf("@")
  const slug = at < 0 ? body : body.slice(0, at)
  if (!SLUG_RE.test(slug)) return undefined
  if (at < 0) return `${COMPACT_PREFIX}${slug}`
  const workspace = body.slice(at + 1)
  return WORKSPACE_RE.test(workspace) ? `${COMPACT_PREFIX}${slug}@${workspace}` : undefined
}

export type OperatorBindingFailure =
  | { code: "operator_unresolvable"; message: string; details: Record<string, unknown> }
  | { code: "delegation_denied"; message: string; details: Record<string, unknown> }

export type OperatorBinding =
  | { ok: true; operator?: string; operatorDigest?: string }
  | ({ ok: false } & OperatorBindingFailure)

/**
 * Validate the `operator` / `operatorDigest` a spawn request names.
 * `callerSessionId` is the daemon-derived caller (never a request field):
 * absent means the host operator, who may name any operator (rule 4). A
 * session caller may name only the operator of its own session, and a nested
 * spawn that names none starts without one, so the caller's is never inherited.
 */
export function resolveOperatorBinding(args: {
  operator?: string
  operatorDigest?: string
  callerSessionId?: string
  operatorOf: (sessionId: string) => string | undefined
}): OperatorBinding {
  const { operator, operatorDigest, callerSessionId, operatorOf } = args
  if (operator === undefined) {
    if (operatorDigest !== undefined) {
      return {
        ok: false,
        code: "operator_unresolvable",
        message: "agent_start: `operatorDigest` needs an `operator` to describe.",
        details: { field: "operatorDigest" },
      }
    }
    return { ok: true }
  }
  const canonical = canonicalOperatorRef(operator)
  if (!canonical) {
    return {
      ok: false,
      code: "operator_unresolvable",
      message:
        `agent_start: \`operator\` "${operator}" is not an AIP-54 operator ref ` +
        "(operator:<slug>, operator:<slug>@<owner>/<workspace>, or ws://operators/<slug>).",
      details: { field: "operator", operator },
    }
  }
  if (callerSessionId !== undefined) {
    const own = operatorOf(callerSessionId)
    if (own === undefined || canonicalOperatorRef(own) !== canonical) {
      return {
        ok: false,
        code: "delegation_denied",
        message:
          `agent_start: a session may name only the operator of its own session; ` +
          `"${operator}" is not the operator of ${callerSessionId}.`,
        details: { field: "operator", operator: canonical, callerSessionId },
      }
    }
  }
  return {
    ok: true,
    operator: canonical,
    ...(operatorDigest !== undefined ? { operatorDigest } : {}),
  }
}

/** Does the recorded digest differ from the current one? Undefined when the
 *  session records no digest or no current digest is known: the daemon cannot
 *  tell, and an unknown is not reported as stale. */
export function operatorDigestStale(
  recorded: string | undefined,
  current: string | undefined,
): boolean | undefined {
  if (recorded === undefined || current === undefined) return undefined
  return recorded !== current
}
