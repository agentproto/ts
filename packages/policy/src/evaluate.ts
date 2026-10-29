/**
 * AIP-38 grant evaluation: a pure function from composed grants and one
 * request to a decision. No I/O, no registry, no clock unless the caller
 * passes none (then `Date.now()` is read once per call).
 *
 * Composition (AIP-38 §Conformance rules 1 and 2): the union of allow
 * grants, a MATCHING deny wins over any allow in any composed policy, and
 * the default is deny unless every composed policy declares `default: allow`.
 *
 * Scope matching follows §Scope matching: rule 1 (exact), rule 2 (trailing
 * `*`), rule 3 (typed forms the caller declares), rule 4 (`selector:<id>`),
 * rule 5 (no scope). Anything the evaluator cannot resolve fails closed:
 * an allow does not match, a deny matches.
 */

import type { Condition, Grant } from "./types.js"

/** A policy document in the shape evaluation needs. */
export interface PolicyGrants {
  default?: "allow" | "deny"
  grants?: readonly Grant[]
}

/** One composed input: a policy (with its default) or a bare grant. */
export type GrantInput = Grant | PolicyGrants

/**
 * `typed` declares the typed scope forms (`<kind>:<value>`, rule 3) the
 * action defines. A kind present in the map is a typed form; its value is
 * the target's value for that kind, `null` when the target has none (matches
 * nothing), or `undefined` when the host cannot resolve it (fails closed).
 * A kind absent from the map is not typed: the scope is a plain string.
 */
export type TypedScopeValues = Readonly<Record<string, string | null | undefined>>

export interface GrantRequest {
  /** The caller's identity refs (`operator://bob`, `session-label://ops`). A grant principal of `*` matches any. */
  principals: readonly string[]
  /** Bare AIP-39 action id (`storage:commit`). The `@agentik/actions/standard/...` spelling of a grant is matched too. */
  action: string
  /** The requested scope. A lone `*` grant scope also matches an absent one. */
  scope?: string
  now?: number | Date
  typed?: TypedScopeValues
  /** Members of the saved selector `<id>`, or `undefined` when it cannot be resolved (rule 4). */
  resolveSelector?: (id: string) => Iterable<string> | undefined
  /** `true`/`false` for a known condition, `undefined` for an unknown kind. Absent resolver: every condition is unknown. */
  evaluateCondition?: (condition: Condition) => boolean | undefined
}

export type GrantDecisionReason =
  | "explicit-deny"
  | "matched-grant"
  | "no-grant"
  | "explicit-revoke"
  | "ttl-expired"
  | "condition-failed"

export interface GrantDecision {
  decision: "allow" | "deny"
  reason: GrantDecisionReason
  /** `grant`: a matching grant decided. `default`: nothing matched and the composed default applied. */
  via: "grant" | "default"
  /** Index of the deciding input, and of the grant inside its policy (absent for a bare grant). */
  inputIndex?: number
  grantIndex?: number
  /** Unknown conditions and other things an author should hear about (AIP-38 conformance rule 6). */
  warnings: string[]
}

/** A grant or policy that is not well formed. Callers fail closed on it. */
export class PolicyGrantError extends Error {
  readonly path: string
  constructor(path: string, message: string) {
    super(`policy grant ${path}: ${message}`)
    this.name = "PolicyGrantError"
    this.path = path
  }
}

const LIBRARY_PREFIX = "@agentik/actions/standard/"

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function validateGrant(g: unknown, path: string): asserts g is Grant {
  if (!isObject(g)) throw new PolicyGrantError(path, "must be an object")
  const p = g.principal
  if (!((typeof p === "string" && p.length > 0) || isObject(p))) {
    throw new PolicyGrantError(`${path}.principal`, "must be a non-empty string or an identity-ref object")
  }
  if (g.effect !== undefined && g.effect !== "allow" && g.effect !== "deny") {
    throw new PolicyGrantError(`${path}.effect`, 'must be "allow" or "deny"')
  }
  if (!Array.isArray(g.actions) || g.actions.length === 0) {
    throw new PolicyGrantError(`${path}.actions`, "must be a non-empty array")
  }
  g.actions.forEach((a: unknown, i: number) => {
    if (!isObject(a) || typeof a.action !== "string" || a.action.length === 0) {
      throw new PolicyGrantError(`${path}.actions[${i}].action`, "must be a non-empty string")
    }
    if (a.scope !== undefined && typeof a.scope !== "string") {
      throw new PolicyGrantError(`${path}.actions[${i}].scope`, "must be a string")
    }
  })
  if (g.conditions !== undefined) {
    if (!Array.isArray(g.conditions)) throw new PolicyGrantError(`${path}.conditions`, "must be an array")
    g.conditions.forEach((c: unknown, i: number) => {
      if (!isObject(c) || typeof c.kind !== "string" || c.kind.length === 0) {
        throw new PolicyGrantError(`${path}.conditions[${i}].kind`, "must be a non-empty string")
      }
    })
  }
  if (g.ttl_seconds !== undefined && !(typeof g.ttl_seconds === "number" && Number.isFinite(g.ttl_seconds) && g.ttl_seconds > 0)) {
    throw new PolicyGrantError(`${path}.ttl_seconds`, "must be a positive number")
  }
  if (g.granted_at !== undefined && typeof g.granted_at !== "string") {
    throw new PolicyGrantError(`${path}.granted_at`, "must be a string")
  }
  if (g.revoked !== undefined && typeof g.revoked !== "boolean") {
    throw new PolicyGrantError(`${path}.revoked`, "must be a boolean")
  }
}

interface FlatGrant {
  grant: Grant
  inputIndex: number
  grantIndex?: number
}

function flatten(inputs: readonly GrantInput[]): { grants: FlatGrant[]; defaultAllow: boolean } {
  const grants: FlatGrant[] = []
  let policies = 0
  let allowing = 0
  inputs.forEach((item, inputIndex) => {
    const path = `[${inputIndex}]`
    if (!isObject(item)) throw new PolicyGrantError(path, "must be a grant or a policy object")
    if ("actions" in item || "principal" in item) {
      validateGrant(item, path)
      grants.push({ grant: item, inputIndex })
      return
    }
    const policy = item as PolicyGrants
    if (policy.default !== undefined && policy.default !== "allow" && policy.default !== "deny") {
      throw new PolicyGrantError(`${path}.default`, 'must be "allow" or "deny"')
    }
    if (policy.grants !== undefined && !Array.isArray(policy.grants)) {
      throw new PolicyGrantError(`${path}.grants`, "must be an array")
    }
    policies += 1
    if (policy.default === "allow") allowing += 1
    ;(policy.grants ?? []).forEach((grant, grantIndex) => {
      validateGrant(grant, `${path}.grants[${grantIndex}]`)
      grants.push({ grant, inputIndex, grantIndex })
    })
  })
  // `default: deny` prevails: allow only when every composed policy says allow explicitly.
  return { grants, defaultAllow: policies > 0 && allowing === policies }
}

type Match = "match" | "no" | "unresolved"

function matchPrincipal(principal: Grant["principal"], refs: readonly string[]): Match {
  const ref = typeof principal === "string" ? principal : isObject(principal) && typeof principal.ref === "string" ? principal.ref : undefined
  if (ref === undefined) return "unresolved"
  return ref === "*" || refs.includes(ref) ? "match" : "no"
}

function matchAction(grantAction: string, requested: string): boolean {
  const forms = requested.startsWith(LIBRARY_PREFIX) ? [requested] : [requested, `${LIBRARY_PREFIX}${requested.replaceAll(":", "-")}`]
  return forms.some(form =>
    grantAction.endsWith("*") ? form.startsWith(grantAction.slice(0, -1)) : grantAction === form,
  )
}

function matchScope(scope: string | undefined, req: GrantRequest): Match {
  if (scope === undefined) return "match" // rule 5
  if (scope.startsWith("selector:")) {
    const members = req.resolveSelector?.(scope.slice("selector:".length))
    if (members === undefined) return "unresolved" // rule 4
    if (req.scope === undefined) return "no"
    for (const m of members) if (m === req.scope) return "match"
    return "no"
  }
  const colon = scope.indexOf(":")
  if (colon > 0 && req.typed && Object.hasOwn(req.typed, scope.slice(0, colon))) {
    const actual = req.typed[scope.slice(0, colon)] // rule 3
    if (actual === undefined) return "unresolved"
    if (actual === null) return "no"
    const value = scope.slice(colon + 1)
    if (value.endsWith("*")) {
      const prefix = value.slice(0, -1)
      return prefix !== "" && actual.startsWith(prefix) ? "match" : "no"
    }
    return actual === value ? "match" : "no"
  }
  if (scope === "*") return "match" // rule 2, lone `*`
  if (req.scope === undefined) return "no"
  if (scope.endsWith("*")) return req.scope.startsWith(scope.slice(0, -1)) ? "match" : "no" // rule 2
  return scope === req.scope ? "match" : "no" // rule 1
}

function nowMs(now: GrantRequest["now"]): number {
  return now === undefined ? Date.now() : now instanceof Date ? now.getTime() : now
}

function expired(g: Grant, now: number): boolean {
  if (g.ttl_seconds === undefined) return false
  const at = g.granted_at === undefined ? Number.NaN : Date.parse(g.granted_at)
  // A missing or unreadable granted_at counts as expired (AIP-38 conformance rule 4).
  return Number.isNaN(at) || now >= at + g.ttl_seconds * 1000
}

/** `true` when every condition holds. An unknown kind is unsatisfied for an allow and satisfied (fail closed) for a deny. */
function conditionsHold(g: Grant, effect: "allow" | "deny", req: GrantRequest, warnings: string[]): boolean {
  for (const c of g.conditions ?? []) {
    const verdict = req.evaluateCondition?.(c)
    if (verdict === undefined) {
      warnings.push(`unknown condition kind "${c.kind}" on a ${effect} grant treated as ${effect === "deny" ? "holding" : "unsatisfied"}`)
      if (effect === "allow") return false
      continue
    }
    if (!verdict) return false
  }
  return true
}

/**
 * Decide one request against composed grants. Throws `PolicyGrantError` on a
 * malformed grant; it never guesses.
 */
export function evaluateGrants(inputs: readonly GrantInput[], request: GrantRequest): GrantDecision {
  const { grants, defaultAllow } = flatten(inputs)
  const now = nowMs(request.now)
  const warnings: string[] = []
  let allowHit: FlatGrant | undefined
  let revoked = false
  let ttl = false
  let condition = false

  for (const flat of grants) {
    const g = flat.grant
    const effect = g.effect ?? "allow"
    const principal = matchPrincipal(g.principal, request.principals)
    if (principal === "no") continue
    const applicable = g.actions.some(a => {
      if (!matchAction(a.action, request.action)) return false
      const scope = matchScope(a.scope, request)
      return scope === "match" || (scope === "unresolved" && effect === "deny")
    })
    if (!applicable) continue
    // Principal fail-closed: an identity form the evaluator cannot read never admits.
    if (principal === "unresolved" && effect === "allow") continue
    if (g.revoked === true) {
      if (effect === "allow") revoked = true
      continue
    }
    if (expired(g, now)) {
      if (effect === "allow") ttl = true
      continue
    }
    if (!conditionsHold(g, effect, request, warnings)) {
      if (effect === "allow") condition = true
      continue
    }
    if (effect === "deny") {
      return {
        decision: "deny",
        reason: "explicit-deny",
        via: "grant",
        inputIndex: flat.inputIndex,
        ...(flat.grantIndex !== undefined ? { grantIndex: flat.grantIndex } : {}),
        warnings,
      }
    }
    allowHit ??= flat
  }

  if (allowHit) {
    return {
      decision: "allow",
      reason: "matched-grant",
      via: "grant",
      inputIndex: allowHit.inputIndex,
      ...(allowHit.grantIndex !== undefined ? { grantIndex: allowHit.grantIndex } : {}),
      warnings,
    }
  }
  if (defaultAllow) return { decision: "allow", reason: "no-grant", via: "default", warnings }
  const reason: GrantDecisionReason = ttl ? "ttl-expired" : condition ? "condition-failed" : revoked ? "explicit-revoke" : "no-grant"
  return { decision: "deny", reason, via: "default", warnings }
}

/**
 * Decide one operation known under several names (a tool and the action it
 * implements): a matching deny on any refuses, a matching allow on any admits.
 */
export function combineDecisions(decisions: readonly GrantDecision[]): GrantDecision {
  const first = decisions[0]
  if (!first) throw new PolicyGrantError("decisions", "needs at least one decision")
  const warnings = decisions.flatMap(d => d.warnings)
  const pick = decisions.find(d => d.reason === "explicit-deny") ?? decisions.find(d => d.decision === "allow" && d.via === "grant") ?? decisions.find(d => d.decision === "allow") ?? first
  return { ...pick, warnings }
}
