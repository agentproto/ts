/**
 * Sentinel signal routing (plan v13, P1): an explicit rule table that says
 * which provider should carry a subject, and why. Read from
 * `config.sentinel.routes` (global config only), resolved per selection.
 *
 * SHADOW ONLY in this release. The router decides, logs and explains; it never
 * changes which provider a sentinel is created on. Every call site still uses
 * the legacy chain (`autoSelectProviderSlug`, the `session:` special case, an
 * explicit `provider`), records what the router WOULD have picked in a `route`
 * stamp on the sentinel, and appends one line to
 * `~/.agentproto/sentinel-routing.jsonl`. A rule's `mode: "enforce"` and
 * `sentinel.routing.mode` are accepted so a table can be written ahead of
 * time, but nothing is applied yet (`applied: false` everywhere).
 *
 * Precedence (deterministic):
 *  1. An explicit `provider` on the call always wins (`rule: "explicit"`). An
 *     explicitly named provider that is not ready refuses, never falls back.
 *  2. Otherwise the matching config rules are ranked by subject specificity
 *     (exact, then longest prefix, a `<scheme>:*` wildcard being the shortest
 *     prefix), then types specificity (exact > glob > none), then the number
 *     of `from` qualifiers. Ties: earlier in the list wins.
 *  3. No config rule matched: the visible builtin table (`builtin:` ids).
 *  4. Candidate walk: a provider in `via` is eligible when it resolves,
 *     declares the subject's scheme in `capabilities.subjects` (or `*`) and is
 *     ready. `fallback: "next-ready"` (the default for `deliver`, which wakes a
 *     session) walks `via` in order and records `fallbackFrom` plus a warning;
 *     `refuse` stops at `via[0]` with `route_unavailable`.
 *
 * Actions are limited to `deliver | forward | drop`. Spawning or invoking an
 * action stays with AIP-71 reactions, so this table never becomes a second
 * reaction engine.
 */

import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"

import { AGENTPUSH_SLUG } from "./sentinel-providers/agentpush.js"
import { LOCAL_GH_SLUG } from "./sentinel-providers/local-gh.js"
import { BUILTIN_SENTINEL_SLUGS } from "./sentinel-providers/registry.js"
import { parseSessionSubject, SESSION_SLUG } from "./sentinel-providers/session.js"
import type { SentinelProviderHandle } from "./sentinel-providers/types.js"
import { autoSelectProviderSlug } from "./sentinel-provider-select.js"
import type { SentinelPublicUrl } from "./sentinel-public-url.js"

// ── Rule schema ───────────────────────────────────────────────────────

/** Where a selection happens, so a rule can differ for auto-linked PRs. */
export const SENTINEL_ROUTE_SITES = ["watch", "autolink", "http", "mcp-events"] as const
export type SentinelRouteSite = (typeof SENTINEL_ROUTE_SITES)[number]

export const sentinelRouteSchema = z
  .object({
    id: z.string().min(1),
    match: z
      .object({
        /** Exact subject, `<prefix>*`, `<scheme>:*`, or `*`. */
        subject: z.string().min(1),
        /** Type globs (`github.check_suite.*`). Matches when one overlaps a
         *  type the watch asks for. */
        types: z.array(z.string().min(1)).optional(),
        from: z
          .object({
            /** The target session's operator label. */
            sessionLabel: z.string().optional(),
            site: z.enum(SENTINEL_ROUTE_SITES).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    /** Ordered provider candidates. */
    via: z.array(z.string().min(1)).min(1),
    /** Default: `next-ready` for `deliver` (it wakes a session), else `refuse`. */
    fallback: z.enum(["next-ready", "refuse"]).optional(),
    /** Default `deliver`. */
    do: z.enum(["deliver", "forward", "drop"]).optional(),
    target: z
      .object({
        urgency: z.enum(["fyi", "next-turn", "steer", "interrupt"]).optional(),
        batchMs: z.number().int().min(0).optional(),
        session: z.string().optional(),
        url: z.string().optional(),
      })
      .passthrough()
      .optional(),
    /** Accepted now, applied in a later release (shadow only today). */
    mode: z.enum(["shadow", "enforce"]).optional(),
  })
  .passthrough()

export type SentinelRoute = z.infer<typeof sentinelRouteSchema>
export const sentinelRoutesSchema = z.array(sentinelRouteSchema)
export const sentinelRoutingModeSchema = z.enum(["shadow", "enforce"])
export type SentinelRoutingMode = z.infer<typeof sentinelRoutingModeSchema>

/** The builtin table, consulted only when no config rule matches. Listed by
 *  `sentinel_routes` so the defaults are never invisible. GitHub stays on
 *  `local-gh` until an agentpush GitHub source is proven end to end. */
export const BUILTIN_SENTINEL_ROUTES: readonly SentinelRoute[] = [
  { id: "builtin:session", match: { subject: "session:*" }, via: [SESSION_SLUG], do: "deliver" },
  { id: "builtin:github", match: { subject: "github:*" }, via: [LOCAL_GH_SLUG], do: "deliver" },
  { id: "builtin:default", match: { subject: "*" }, via: [AGENTPUSH_SLUG], fallback: "refuse", do: "deliver" },
]

/** Parse the raw `config.sentinel.routes` value. Invalid rows are dropped
 *  with a warning instead of failing every selection. */
export function parseSentinelRoutes(raw: unknown): { routes: SentinelRoute[]; warnings: string[] } {
  if (raw === undefined || raw === null) return { routes: [], warnings: [] }
  if (!Array.isArray(raw)) return { routes: [], warnings: ["sentinel.routes is not an array, ignored"] }
  const routes: SentinelRoute[] = []
  const warnings: string[] = []
  raw.forEach((row, i) => {
    const parsed = sentinelRouteSchema.safeParse(row)
    if (parsed.success) routes.push(parsed.data)
    else warnings.push(`sentinel.routes[${i}] is invalid and ignored: ${parsed.error.issues.map(x => `${x.path.join(".")} ${x.message}`).join("; ")}`)
  })
  return { routes, warnings }
}

// ── Matching ──────────────────────────────────────────────────────────

/** `github:o/r#1` → `github`; a subject without a scheme has none. */
export function subjectScheme(subject: string): string | undefined {
  const i = subject.indexOf(":")
  return i > 0 ? subject.slice(0, i) : undefined
}

/** Subject specificity: exact beats any prefix, a longer prefix beats a
 *  shorter one. `undefined` when the pattern does not match. */
function subjectScore(pattern: string, subject: string): number | undefined {
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1)
    return subject.startsWith(prefix) ? prefix.length : undefined
  }
  return pattern === subject ? Number.MAX_SAFE_INTEGER : undefined
}

/** Two type globs overlap when one can match a type the other matches. */
function typesOverlap(a: string, b: string): boolean {
  const pa = a.endsWith("*") ? a.slice(0, -1) : undefined
  const pb = b.endsWith("*") ? b.slice(0, -1) : undefined
  if (pa === undefined && pb === undefined) return a === b
  if (pa !== undefined && pb !== undefined) return pa.startsWith(pb) || pb.startsWith(pa)
  return pa !== undefined ? b.startsWith(pa) : a.startsWith(pb!)
}

export interface SentinelRouteFrom {
  sessionLabel?: string
}

export interface SentinelRouteRequest {
  subject: string
  types?: string[]
  site: SentinelRouteSite
  from?: SentinelRouteFrom
  /** Explicit `provider` on the call. */
  provider?: string
  /** Target kind of the watch, only used to replay the legacy choice (the
   *  HTTP webhook-target branch has no `session:` special case). */
  targetKind?: "session" | "webhook"
}

type Rank = [number, number, number]

function rankRule(rule: SentinelRoute, req: SentinelRouteRequest): Rank | undefined {
  const s = subjectScore(rule.match.subject, req.subject)
  if (s === undefined) return undefined
  let t = 0
  if (rule.match.types && rule.match.types.length > 0) {
    const asked = req.types ?? []
    if (!rule.match.types.some(rt => asked.some(at => typesOverlap(rt, at)))) return undefined
    t = rule.match.types.some(rt => rt.includes("*")) ? 1 : 2
  }
  let f = 0
  const from = rule.match.from
  if (from?.site !== undefined) {
    if (from.site !== req.site) return undefined
    f++
  }
  if (from?.sessionLabel !== undefined) {
    if (from.sessionLabel !== req.from?.sessionLabel) return undefined
    f++
  }
  return [s, t, f]
}

const better = (a: Rank, b: Rank): boolean => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]

/** The winning rule among `rules` (strictly better rank wins, so a tie keeps
 *  the earlier one), or undefined. */
export function matchSentinelRoute(rules: readonly SentinelRoute[], req: SentinelRouteRequest): SentinelRoute | undefined {
  let best: { rule: SentinelRoute; rank: Rank } | undefined
  for (const rule of rules) {
    const rank = rankRule(rule, req)
    if (rank && (!best || better(rank, best.rank))) best = { rule, rank }
  }
  return best?.rule
}

// ── Resolution ────────────────────────────────────────────────────────

export interface SentinelRouteWalkStep {
  provider: string
  /** Absent when the provider was eligible. */
  rejected?: string
  durable?: boolean
}

export interface SentinelRouteDecision {
  /** The provider the router picks, or null when it refuses. */
  slug: string | null
  /** Winning rule id: a config id, `builtin:<name>` or `explicit`. */
  rule: string
  reason: string
  walked: SentinelRouteWalkStep[]
  do: "deliver" | "forward" | "drop"
  fallback: "next-ready" | "refuse"
  /** The rule's own mode (default `shadow`). */
  ruleMode: SentinelRoutingMode
  /** Always false in this release: the decision is never applied. */
  applied: false
  fallbackFrom?: string
  warning?: string
  /** `route_unavailable` when the router refuses. */
  error?: "route_unavailable"
}

export interface SentinelRouteDeps {
  resolveProvider: (slug: string) => Promise<SentinelProviderHandle | null>
  /** Config rules, already parsed. */
  routes: readonly SentinelRoute[]
}

/** Eligibility of one provider for `scheme`: resolves, declares the scheme,
 *  is ready. A probe that throws counts as not ready (same as the chain).
 *  `scheme: null` skips the scheme check (readiness only, for listings). */
async function probe(
  slug: string,
  scheme: string | undefined | null,
  resolveProvider: SentinelRouteDeps["resolveProvider"],
): Promise<SentinelRouteWalkStep> {
  let handle: SentinelProviderHandle | null
  try {
    handle = await resolveProvider(slug)
  } catch (err) {
    return { provider: slug, rejected: `unavailable: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!handle) return { provider: slug, rejected: "unavailable: provider is not installed" }
  const durable = handle.capabilities?.durable
  const subjects = handle.capabilities?.subjects ?? ["*"]
  if (scheme !== null && !subjects.includes("*") && (scheme === undefined || !subjects.includes(scheme))) {
    return { provider: slug, rejected: `does not serve scheme "${scheme ?? "(none)"}" (serves ${subjects.join(", ")})`, ...(durable !== undefined ? { durable } : {}) }
  }
  if (handle.readiness) {
    try {
      const r = await handle.readiness()
      if (!r.ready) return { provider: slug, rejected: `unready: ${r.reason ?? "not ready"}`, ...(durable !== undefined ? { durable } : {}) }
    } catch (err) {
      return { provider: slug, rejected: `unready: probe failed (${err instanceof Error ? err.message : String(err)})`, ...(durable !== undefined ? { durable } : {}) }
    }
  }
  return { provider: slug, ...(durable !== undefined ? { durable } : {}) }
}

export async function resolveSentinelRoute(
  req: SentinelRouteRequest,
  deps: SentinelRouteDeps,
): Promise<SentinelRouteDecision> {
  const scheme = subjectScheme(req.subject)

  if (req.provider) {
    const step = await probe(req.provider, scheme, deps.resolveProvider)
    const base = { rule: "explicit", walked: [step], do: "deliver" as const, fallback: "refuse" as const, ruleMode: "shadow" as const, applied: false as const }
    if (step.rejected) {
      return { ...base, slug: null, error: "route_unavailable", reason: `explicit provider "${req.provider}" ${step.rejected}; an explicitly named provider refuses, no fallback` }
    }
    return { ...base, slug: req.provider, reason: `explicit provider "${req.provider}" on the call` }
  }

  const fromConfig = matchSentinelRoute(deps.routes, req)
  const rule = fromConfig ?? matchSentinelRoute(BUILTIN_SENTINEL_ROUTES, req)!
  const action = rule.do ?? "deliver"
  const fallback = rule.fallback ?? (action === "deliver" ? "next-ready" : "refuse")
  const base = {
    rule: rule.id,
    do: action,
    fallback,
    ruleMode: rule.mode ?? ("shadow" as const),
    applied: false as const,
  }
  const why = fromConfig ? `config rule "${rule.id}" matched ${rule.match.subject}` : `no config rule matched; ${rule.id} (${rule.match.subject})`

  const walked: SentinelRouteWalkStep[] = []
  const candidates = fallback === "refuse" ? rule.via.slice(0, 1) : rule.via
  for (const slug of candidates) {
    const step = await probe(slug, scheme, deps.resolveProvider)
    walked.push(step)
    if (step.rejected) continue
    if (slug === rule.via[0]) return { ...base, slug, walked, reason: `${why}, via ${slug}` }
    const first = walked[0]!
    return {
      ...base,
      slug,
      walked,
      fallbackFrom: first.provider,
      warning: `route "${rule.id}" fell back from ${first.provider} (${first.rejected}) to ${slug}`,
      reason: `${why}, ${first.provider} rejected, fell back to ${slug}`,
    }
  }
  const first = walked[0]!
  return {
    ...base,
    slug: null,
    walked,
    error: "route_unavailable",
    reason:
      fallback === "refuse"
        ? `${why}; ${first.provider} ${first.rejected} (fallback: refuse)`
        : `${why}; no provider in via is eligible`,
  }
}

// ── Legacy replay (what is actually used today) ───────────────────────

export interface SentinelLegacyDeps {
  resolveProvider: (slug: string) => Promise<SentinelProviderHandle | null>
  publicUrl?: () => SentinelPublicUrl | undefined
}

/** Replays the provider the call sites pick today, so `explain` can show it
 *  next to the router's choice. Mirrors `createSentinelWatch` (explicit, the
 *  `session:` case, then the chain), the HTTP webhook-target branch (no
 *  `session:` case) and mcp-events (`local-gh`). */
export async function legacySentinelProvider(req: SentinelRouteRequest, deps: SentinelLegacyDeps): Promise<string> {
  if (req.provider) return req.provider
  if (req.site === "mcp-events") return LOCAL_GH_SLUG
  if (req.targetKind !== "webhook" && req.site !== "autolink" && parseSessionSubject(req.subject) !== undefined) return SESSION_SLUG
  return autoSelectProviderSlug({ resolveProvider: deps.resolveProvider, ...(deps.publicUrl ? { publicUrl: deps.publicUrl } : {}) })
}

// ── Shadow log + stamp ────────────────────────────────────────────────

/** Stamped on a created sentinel: what the router decided, next to the
 *  provider actually used. `applied: false` means the router did not choose
 *  the provider (shadow). */
export interface SentinelRouteStamp {
  rule: string
  reason: string
  /** The router's pick (null: it would refuse). */
  routed: string | null
  /** The provider actually used (legacy selection). */
  legacy: string
  applied: false
  fallbackFrom?: string
  warning?: string
}

/** One line of `sentinel-routing.jsonl`. No payload, no credentials. */
export interface SentinelRouteLogLine {
  ts: string
  site: SentinelRouteSite
  subject: string
  types?: string[]
  legacy: string
  routed: string | null
  rule: string
  reason: string
  applied: false
  fallbackFrom?: string
  warning?: string
}

export const SENTINEL_ROUTING_LOG_PATH = (): string =>
  resolve(process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto"), "sentinel-routing.jsonl")

/** Best-effort append to `sentinel-routing.jsonl`; never throws. */
export async function appendSentinelRouteLog(line: SentinelRouteLogLine, filePath: string = SENTINEL_ROUTING_LOG_PATH()): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true })
    await appendFile(filePath, JSON.stringify(line) + "\n", { mode: 0o600 })
  } catch {
    // Shadow logging must never affect a watch.
  }
}

/** The parsed `config.sentinel` routing section. */
export interface SentinelRoutesConfig {
  routes: readonly SentinelRoute[]
  /** Parse warnings (invalid rows dropped). */
  warnings?: string[]
  mode?: SentinelRoutingMode
}

/** Parse the raw `config.sentinel` object into {@link SentinelRoutesConfig}. */
export function sentinelRoutesConfigFrom(sentinel: { routes?: unknown; routing?: { mode?: unknown } } | undefined): SentinelRoutesConfig {
  const { routes, warnings } = parseSentinelRoutes(sentinel?.routes)
  const mode = sentinelRoutingModeSchema.safeParse(sentinel?.routing?.mode)
  return { routes, warnings, ...(mode.success ? { mode: mode.data } : {}) }
}

/** What a call site wires to opt into shadow routing. */
export interface SentinelRoutingDeps {
  /** Current config rules, read fresh per selection. */
  config: () => Promise<SentinelRoutesConfig> | SentinelRoutesConfig
  /** Decision sink. Defaults to {@link appendSentinelRouteLog}. */
  log?: (line: SentinelRouteLogLine) => void | Promise<void>
  /** Session qualifiers for `match.from` (operator label). */
  fromSession?: (sessionId: string) => SentinelRouteFrom | undefined
}

/** Decide in shadow, log one line, return the stamp. Never throws: a router
 *  failure returns undefined and the watch proceeds exactly as before. */
export async function shadowSentinelRoute(
  routing: SentinelRoutingDeps,
  resolveProvider: SentinelRouteDeps["resolveProvider"],
  req: Omit<SentinelRouteRequest, "from"> & { sessionId?: string },
  legacy: string,
): Promise<SentinelRouteStamp | undefined> {
  try {
    const from = req.sessionId ? routing.fromSession?.(req.sessionId) : undefined
    const decision = await resolveSentinelRoute(
      { subject: req.subject, site: req.site, ...(req.types ? { types: req.types } : {}), ...(req.provider ? { provider: req.provider } : {}), ...(from ? { from } : {}) },
      { resolveProvider, routes: (await routing.config()).routes },
    )
    const stamp: SentinelRouteStamp = {
      rule: decision.rule,
      reason: decision.reason,
      routed: decision.slug,
      legacy,
      applied: false,
      ...(decision.fallbackFrom ? { fallbackFrom: decision.fallbackFrom } : {}),
      ...(decision.warning ? { warning: decision.warning } : {}),
    }
    const line: SentinelRouteLogLine = {
      ts: new Date().toISOString(),
      site: req.site,
      subject: req.subject,
      ...(req.types ? { types: req.types } : {}),
      legacy,
      routed: decision.slug,
      rule: decision.rule,
      reason: decision.reason,
      applied: false,
      ...(decision.fallbackFrom ? { fallbackFrom: decision.fallbackFrom } : {}),
      ...(decision.warning ? { warning: decision.warning } : {}),
    }
    await (routing.log ?? appendSentinelRouteLog)(line)
    return stamp
  } catch {
    return undefined
  }
}

// ── List + explain (read-only surfaces) ───────────────────────────────

export interface SentinelProviderRouteInfo {
  slug: string
  ready: boolean
  reason?: string
  subjects?: string[]
  durable?: boolean
}

export interface SentinelRouteRow extends SentinelRoute {
  source: "config" | "builtin"
}

export interface SentinelRoutesListing {
  /** Effective mode in this release, whatever is configured. */
  mode: "shadow"
  /** `sentinel.routing.mode` as configured (default `shadow`). */
  configuredMode: SentinelRoutingMode
  applied: false
  note: string
  routes: SentinelRouteRow[]
  providers: SentinelProviderRouteInfo[]
  warnings: string[]
}

const SHADOW_NOTE =
  "shadow only: the router decides, logs and explains, but every sentinel is still created on the legacy choice " +
  "(explicit provider, session: subjects on session, else agentpush > webhook > local-gh). mode: enforce is accepted, not applied yet."

/** Validator warnings over a parsed table: duplicate ids, rules that can
 *  never win, `forward` without a url, and `via` providers that do not
 *  declare the scheme (when the provider resolves). */
export async function validateSentinelRoutes(
  routes: readonly SentinelRoute[],
  resolveProvider?: SentinelRouteDeps["resolveProvider"],
): Promise<string[]> {
  const warnings: string[] = []
  const seen = new Set<string>()
  const key = (r: SentinelRoute): string =>
    JSON.stringify([r.match.subject, [...(r.match.types ?? [])].sort(), r.match.from?.site, r.match.from?.sessionLabel])
  const keys = new Map<string, string>()
  for (const r of routes) {
    if (seen.has(r.id)) warnings.push(`route "${r.id}": duplicate id`)
    seen.add(r.id)
    if (r.id.startsWith("builtin:") || r.id === "explicit") warnings.push(`route "${r.id}": reserved id prefix`)
    const k = key(r)
    const earlier = keys.get(k)
    if (earlier !== undefined) warnings.push(`route "${r.id}": same match as earlier route "${earlier}", it never wins`)
    else keys.set(k, r.id)
    if ((r.do ?? "deliver") === "forward" && !r.target?.url) warnings.push(`route "${r.id}": do "forward" without target.url`)
    if (resolveProvider) {
      const scheme = r.match.subject.endsWith("*") ? subjectScheme(r.match.subject.slice(0, -1)) : subjectScheme(r.match.subject)
      for (const slug of r.via) {
        const handle = await resolveProvider(slug).catch(() => null)
        if (!handle) {
          warnings.push(`route "${r.id}": via provider "${slug}" is not installed`)
          continue
        }
        const subjects = handle.capabilities?.subjects ?? ["*"]
        if (scheme && !subjects.includes("*") && !subjects.includes(scheme)) {
          warnings.push(`route "${r.id}": via provider "${slug}" does not declare scheme "${scheme}"`)
        }
      }
    }
  }
  return warnings
}

export async function listSentinelRoutes(
  deps: SentinelRouteDeps & { parseWarnings?: string[]; configuredMode?: SentinelRoutingMode },
): Promise<SentinelRoutesListing> {
  const slugs = new Set<string>(BUILTIN_SENTINEL_SLUGS)
  for (const r of deps.routes) for (const s of r.via) slugs.add(s)
  const providers: SentinelProviderRouteInfo[] = []
  for (const slug of slugs) {
    const step = await probe(slug, null, deps.resolveProvider)
    const handle = await deps.resolveProvider(slug).catch(() => null)
    providers.push({
      slug,
      ready: !step.rejected,
      ...(step.rejected ? { reason: step.rejected } : {}),
      ...(handle?.capabilities ? { subjects: handle.capabilities.subjects, durable: handle.capabilities.durable } : {}),
    })
  }
  return {
    mode: "shadow",
    configuredMode: deps.configuredMode ?? "shadow",
    applied: false,
    note: SHADOW_NOTE,
    routes: [
      ...deps.routes.map(r => ({ ...r, source: "config" as const })),
      ...BUILTIN_SENTINEL_ROUTES.map(r => ({ ...r, source: "builtin" as const })),
    ],
    providers,
    warnings: [...(deps.parseWarnings ?? []), ...(await validateSentinelRoutes(deps.routes, deps.resolveProvider))],
  }
}

export interface SentinelRouteExplanation extends SentinelRouteDecision {
  subject: string
  site: SentinelRouteSite
  /** The provider the daemon actually uses today for this request. */
  legacy: string
  note: string
}

export async function explainSentinelRoute(
  req: SentinelRouteRequest,
  deps: SentinelRouteDeps & SentinelLegacyDeps,
): Promise<SentinelRouteExplanation> {
  const decision = await resolveSentinelRoute(req, deps)
  const legacy = await legacySentinelProvider(req, deps)
  return { subject: req.subject, site: req.site, ...decision, legacy, note: SHADOW_NOTE }
}
