/**
 * MCP Events registry (W-C of `.plans/sentinel-mcp-events/PLAN.md`, §2/§3).
 *
 * One object per provider scheme. Every registration carries the WIRE
 * `EventDefinition` (name / description / `delivery:["webhook"]` /
 * `inputSchema` / `payloadSchema` — official doc verbatim, no extra fields)
 * PLUS the internal `InternalEventMeta`. Two fields on the meta are
 * MANDATORY by type: `argumentsToMatch` (the missing link between
 * `document_id`-style subscription args and `SentinelSpec.match`) and
 * `authorize`. A registration that omits either does not compile.
 *
 * `replayable` is INTERNAL only (it drives `cursor:null` for v1) and must
 * never appear on the wire — the §3 `EventDefinition` has no such field.
 *
 * Day-1 scheme: `github`. The definitions are derived from the ACTUAL event
 * types the providers declare/emit in `sentinel-providers/` (verified with
 * `rg 'github\.' packages/runtime/src/sentinel-providers`) — NOT from the
 * illustrative names in the plan's task text. See `GITHUB_SCHEME` below.
 */

import type { SentinelMatchClause } from "../sentinel-providers/types.js"

// ── Principal (frozen: exactly two constructors) ─────────────────────────

declare const PRINCIPAL_BRAND: unique symbol

/**
 * The authenticated caller of a native MCP `events/*` call. REALITY (plan
 * §1): the root `/mcp` transport authenticates with ONE daemon bearer (or
 * trusted loopback) and exposes only an optional `callerSessionId` — there is
 * no per-caller auth-profile principal yet. So v1 has exactly two
 * constructors; a future W-F multi-tenant widening touches this one file.
 */
export type Principal = string & { readonly [PRINCIPAL_BRAND]: true }

export function daemonBearerPrincipal(): Principal {
  return "daemon-bearer" as Principal
}

export function sessionPrincipal(sessionId: string): Principal {
  return `session:${sessionId}` as Principal
}

// ── Types (§3 frozen) ────────────────────────────────────────────────────

export interface EventDefinition {
  name: string
  description: string
  delivery: ["webhook"]
  inputSchema: object
  payloadSchema: object
}

/** What `argumentsToMatch` produces: explicit Sentinel match clauses plus the
 *  provider slug that can emit the event. `ok:false` becomes `-32602` with a
 *  definition-specific reason. */
export type ArgumentsResult =
  | { ok: true; matchClauses: SentinelMatchClause[]; providerSlug: string }
  | { ok: false; reason: string }

export interface InternalEventMeta {
  /** INTERNAL: drives `cursor:null` vs a provider cursor. v1 is all-false. */
  replayable: boolean
  /** Map `inputSchema`-validated args to explicit match clauses (pure). */
  argumentsToMatch: (args: Record<string, unknown>) => ArgumentsResult
  /** Authorization gate for the given principal. */
  authorize: (args: Record<string, unknown>, principal: Principal) => boolean
}

export interface EventRegistration {
  definition: EventDefinition
  meta: InternalEventMeta
}

export interface SchemeRegistry {
  scheme: string
  events: EventRegistration[]
}

// ── Minimal JSON-Schema validation (inputSchema is the contract) ──────────

type SchemaNode = Record<string, unknown>

function typeMatches(type: unknown, value: unknown): boolean {
  if (Array.isArray(type)) return type.some((t) => typeMatches(t, value))
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value)
    case "array":
      return Array.isArray(value)
    case "string":
      return typeof value === "string"
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "boolean":
      return typeof value === "boolean"
    case "null":
      return value === null
    default:
      return true
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const ak = Object.keys(ao)
    const bk = Object.keys(bo)
    return ak.length === bk.length && ak.every((k) => deepEqual(ao[k], bo[k]))
  }
  return false
}

function validateNode(schema: SchemaNode, value: unknown, path: string): { ok: true } | { ok: false; reason: string } {
  const at = path || "$"
  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    return { ok: false, reason: `${at}: expected ${String(schema.type)}` }
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    return { ok: false, reason: `${at}: must equal the const value` }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    return { ok: false, reason: `${at}: not one of the allowed values` }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
    for (const key of required) {
      if (!(key in obj)) return { ok: false, reason: `${at}: missing required property "${key}"` }
    }
    const properties = (schema.properties ?? {}) as Record<string, SchemaNode>
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) return { ok: false, reason: `${at}: unexpected property "${key}"` }
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (key in obj) {
        const result = validateNode(sub, obj[key], `${path}.${key}`)
        if (!result.ok) return result
      }
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    const items = schema.items as SchemaNode
    for (let i = 0; i < value.length; i++) {
      const result = validateNode(items, value[i], `${path}[${i}]`)
      if (!result.ok) return result
    }
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return { ok: false, reason: `${at}: shorter than ${schema.minLength}` }
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      return { ok: false, reason: `${at}: does not match the required pattern` }
    }
  }
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) {
    return { ok: false, reason: `${at}: below the minimum ${schema.minimum}` }
  }
  return { ok: true }
}

/** Validate subscription args against a definition's `inputSchema`. */
export function validateAgainstInputSchema(
  schema: object,
  args: unknown,
): { ok: true } | { ok: false; reason: string } {
  return validateNode(schema as SchemaNode, args, "")
}

// ── GitHub scheme (day-1) ────────────────────────────────────────────────

/**
 * Subscription args shared by every day-1 github event: a PR identity. The
 * only zero-infra provider that can serve these is `local-gh`, which watches
 * exactly one PR subject (`github:owner/repo#number`).
 */
const PR_ARGS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    repo: {
      type: "string",
      description: "Repository in `owner/name` form, e.g. `agentproto/ts`.",
      pattern: "^[^/\\s]+/[^/\\s]+$",
    },
    number: {
      type: "integer",
      description: "Pull request number.",
      minimum: 1,
    },
  },
  required: ["repo", "number"],
  additionalProperties: false,
} as const

/** The envelope extension fields `toMcpEvent` always adds to `data`. */
const ENVELOPE_DATA_PROPERTIES = {
  subject: { type: "string", description: "CloudEvents subject the event is filed under." },
  summary: { type: "string", description: "One-line human-readable summary." },
} as const

function payloadSchema(properties: Record<string, unknown>, required: readonly string[]): object {
  return {
    type: "object",
    properties: { ...properties, ...ENVELOPE_DATA_PROPERTIES },
    required: [...required, "subject", "summary"],
    additionalProperties: false,
  }
}

/**
 * Map PR args to a single match clause pinned to the event type. `local-gh`
 * emits the type; the runtime applies the clause server-side (`sentinel-
 * runtime.ts` `eventMatchesSpec`) before any delivery.
 */
function githubPrArgumentsToMatch(eventName: string) {
  return (args: Record<string, unknown>): ArgumentsResult => {
    const repo = args.repo
    const number = args.number
    if (typeof repo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
      return { ok: false, reason: "`repo` must be `owner/name`" }
    }
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
      return { ok: false, reason: "`number` must be a positive integer" }
    }
    return {
      ok: true,
      matchClauses: [{ subject: `github:${repo}#${number}`, types: [eventName] }],
      providerSlug: "local-gh",
    }
  }
}

/** v1 is single-tenant: every principal reaches every registered scheme. */
function githubAuthorize(_args: Record<string, unknown>, _principal: Principal): boolean {
  return true
}

function githubEvent(input: {
  name: string
  description: string
  payloadSchema: object
}): EventRegistration {
  return {
    definition: {
      name: input.name,
      description: input.description,
      delivery: ["webhook"],
      inputSchema: PR_ARGS_INPUT_SCHEMA as unknown as object,
      payloadSchema: input.payloadSchema,
    },
    meta: {
      // v1 REALITY: no provider has historical replay (plan §2) — every
      // definition is non-replayable and always returns `cursor: null`.
      replayable: false,
      argumentsToMatch: githubPrArgumentsToMatch(input.name),
      authorize: githubAuthorize,
    },
  }
}

/**
 * The day-1 github scheme. Types are the ACTUAL `github.*` strings emitted by
 * `sentinel-providers/local-gh.ts` (the zero-infra provider the plan names):
 *   - github.pull_request.closed
 *   - github.pull_request.synchronize
 *   - github.pull_request_review.submitted
 *   - github.check_suite.completed
 *
 * The plan's illustrative `github.pull_request.opened` and
 * `github.build.failed` do NOT exist in `sentinel-providers/` (opened is only
 * producible by the push `webhook` provider's normalizer; build.failed exists
 * nowhere — the closest real signal is `github.check_suite.completed` with
 * `data.conclusion === "failure"`). Per the plan's own instruction to surface
 * actual declared values, only real types ship — no fabricated definition.
 *
 * `local-gh`'s `defaultTypes()` also lists `github.workflow_run.completed` and
 * `github.issue_comment.created`, but its poll implementation does not emit
 * them (documented in `local-gh.ts`); shipping them here would advertise
 * subscriptions that can never fire, so they are intentionally omitted.
 */
export const GITHUB_SCHEME: SchemeRegistry = {
  scheme: "github",
  events: [
    githubEvent({
      name: "github.pull_request.closed",
      description: "A pull request was closed or merged.",
      payloadSchema: payloadSchema(
        {
          action: { type: "string", const: "closed" },
          merged: { type: "boolean", description: "True when the PR was merged rather than closed unmerged." },
          repo: { type: "string" },
          number: { type: "integer" },
        },
        ["action", "merged", "repo", "number"],
      ),
    }),
    githubEvent({
      name: "github.pull_request.synchronize",
      description: "New commits were pushed to a pull request's head branch.",
      payloadSchema: payloadSchema(
        {
          action: { type: "string", const: "synchronize" },
          repo: { type: "string" },
          number: { type: "integer" },
          headSha: { type: "string" },
        },
        ["action", "repo", "number", "headSha"],
      ),
    }),
    githubEvent({
      name: "github.pull_request_review.submitted",
      description: "A review was submitted on a pull request.",
      payloadSchema: payloadSchema(
        {
          action: { type: "string", const: "submitted" },
          state: { type: "string", description: "Review state, e.g. `approved`, `changes_requested`." },
          repo: { type: "string" },
          number: { type: "integer" },
          actor: { type: "string" },
        },
        ["action", "state", "repo", "number", "actor"],
      ),
    }),
    githubEvent({
      name: "github.check_suite.completed",
      description: "The checks on a pull request finished (a `failure` conclusion is the build-failed signal).",
      payloadSchema: payloadSchema(
        {
          action: { type: "string", const: "completed" },
          conclusion: { type: "string", description: "Rolled-up worst-of conclusion across the completed checks." },
          repo: { type: "string" },
          number: { type: "integer" },
          checks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                conclusion: { type: ["string", "null"] },
              },
              required: ["name", "conclusion"],
              additionalProperties: true,
            },
          },
        },
        ["action", "conclusion", "repo", "number", "checks"],
      ),
    }),
  ],
}

/** Every registered scheme. Adding a scheme = one object + one test row. */
export const EVENT_REGISTRY: readonly SchemeRegistry[] = [GITHUB_SCHEME]

/** The schemes a principal may discover/subscribe to. v1: single tenant, all. */
export function tenantScope(_principal: Principal): readonly SchemeRegistry[] {
  return EVENT_REGISTRY
}

/** Look up a registration by official wire name (all schemes). */
export function findEventDefinition(name: string): EventRegistration | undefined {
  for (const scheme of EVENT_REGISTRY) {
    for (const event of scheme.events) {
      if (event.definition.name === name) return event
    }
  }
  return undefined
}
