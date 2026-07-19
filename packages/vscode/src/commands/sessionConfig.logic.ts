/**
 * Pure logic for the per-session CONFIG picker — the "terminal join" of the
 * `agentproto-session-config-axes` work (SPEC §6, build step 8). No `vscode`
 * import, so this is directly unit-testable exactly like changeModel.logic.ts /
 * spawn.logic.ts; the interactive flow (sessionConfig.ts) calls into it.
 *
 * The single idea (SPEC §6): every chip is POPULATED from
 * `resolveCapabilities(adapter, model)` (§3.9) and BOUND to one daemon verb
 * (§4.5). A chip whose resolved option-set is empty is HIDDEN (not a dead
 * affordance); a chip whose apply-path is restart-only is restart-tagged with a
 * persistent "⟲ restart required" affix. The strip is NOT a fixed six — it's
 * whatever the current adapter × model actually supports, so the same adapter
 * yields a different strip per model (opus shows `ultracode`, haiku doesn't).
 *
 * Deliberately REUSES `mapChangeModelQuickPickItems` (changeModel.logic.ts) for
 * the model chip's rows rather than re-deriving the model menu or the model↔route
 * restart trap — that function already groups the adapter's models and flags a
 * cross-route / arg-strategy row `restartRequired` (§4.4, §1a). This module only
 * adds the OTHER five axes + the two session actions around it.
 */

import type {
  AuthMethod,
  CanonicalPosture,
  ContextProfile,
  EffortLevel,
  Posture,
  SessionDescriptor,
} from "../client/types.js"
import { mapChangeModelQuickPickItems } from "./changeModel.logic.js"
import type { SpawnAdapterInfo } from "./spawn.logic.js"

/** The persistent affix a restart-only chip renders (SPEC §6 rendering rule 2). */
export const RESTART_AFFIX = "⟲ restart required"

// ── Client mirrors of the daemon read-surfaces the picker consumes ──────────
//    (mirrored by hand, no runtime import, same convention as client/types.ts).

/**
 * Mirror of ACP `SessionMode` (SDK `types.gen.d.ts:4209`), surfaced read-only by
 * the #482 capability layer as a session's advertised native modes
 * (`SessionModeState.availableModes`). The posture chip's native rows come from
 * this; a canonical posture with no match here falls to prompt-injection (§3.4a).
 */
export interface HarnessMode {
  id: string
  name?: string
  description?: string
}

/**
 * Mirror of the runtime `CatalogRoute` (`catalog-models.ts`, SPEC §5.3) — the
 * subset the picker reads. `eligibleProfiles` is the profile-aware answer the
 * access chip populates from; `runnable:false` means no eligible profile exists
 * for this route (SPEC §6 rendering rule 5), not merely "no bare key".
 */
export interface CatalogRouteRow {
  route: string
  ref: string
  baseUrl: string | null
  runnable: boolean
  eligibleProfiles: string[]
  adapterModes: string[]
  curated: boolean
}
export interface CatalogProductRow {
  product: string
  routes: CatalogRouteRow[]
}
export interface CatalogVendorRow {
  vendor: string
  products: CatalogProductRow[]
}
/** Mirror of the runtime `CatalogModelsResponse` (`GET /catalog/models`). */
export interface CatalogModelsResult {
  vendors: CatalogVendorRow[]
}

/**
 * Non-secret projection of a named auth profile (mirror of `@agentproto/auth`'s
 * `AuthProfile`) the access chip lists. NEVER carries the credential — only the
 * `id` (the `profileRef` a restart-override attaches, §4.3), the `vendor`/`method`
 * eligibility facets (§1c), and a display `label`.
 */
export interface AuthProfileRow {
  id: string
  vendor: string
  method: AuthMethod
  label?: string
}

// ── Canonical-posture native-vs-advisory helper (client mirror of the runtime
//    canonical-posture.ts alias map — the picker needs it to label a row
//    "enforced" vs "advisory", SPEC risk Rw). Kept minimal. ──────────────────

/**
 * agentproto-canonical posture → the harness `SessionModeId`s that mean the same
 * thing. Mirror of the runtime `POSTURE_NATIVE_ALIASES` (canonical-posture.ts):
 * matching is case/separator-insensitive (see {@link normalizeModeId}), so one
 * readable spelling covers every casing/hyphenation a harness advertises.
 */
export const POSTURE_NATIVE_ALIASES: Readonly<Record<CanonicalPosture, readonly string[]>> = {
  default: ["default", "build", "normal", "standard"],
  plan: ["plan", "planning", "plan-mode"],
  "accept-edits": ["accept-edits", "auto-accept", "auto-edit"],
  bypass: ["bypass", "bypass-permissions", "full-access", "yolo", "dangerously-skip-permissions"],
  "read-only": ["read-only", "chat", "ask"],
}

/** The canonical posture vocabulary as a value list (keys of the alias map). */
export const CANONICAL_POSTURES: readonly CanonicalPosture[] = Object.keys(
  POSTURE_NATIVE_ALIASES,
) as CanonicalPosture[]

/** Lowercase + strip non-alphanumerics so `acceptEdits` ≡ `accept-edits`. */
export function normalizeModeId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "")
}

const CANONICAL_BY_NORMALIZED_ALIAS: ReadonlyMap<string, CanonicalPosture> = (() => {
  const index = new Map<string, CanonicalPosture>()
  for (const [posture, aliases] of Object.entries(POSTURE_NATIVE_ALIASES) as [
    CanonicalPosture,
    readonly string[],
  ][]) {
    for (const alias of aliases) index.set(normalizeModeId(alias), posture)
  }
  return index
})()

/** Which canonical posture (if any) a harness mode id normalizes to. */
export function canonicalForModeId(modeId: string): CanonicalPosture | undefined {
  return CANONICAL_BY_NORMALIZED_ALIAS.get(normalizeModeId(modeId))
}

// ── Resolved capabilities (SPEC §3.9) ───────────────────────────────────────

/** One posture row — native (harness-enforced, live) or advisory (prompt-injected,
 *  restart). `enforcement` is the load-bearing label distinction (SPEC risk Rw):
 *  NEVER present an advisory posture as a permission boundary. */
export interface PostureRow {
  /** The wire value a pick sends: a canonical posture string, or a raw harness
   *  mode id for a native mode the canonical vocabulary doesn't name. */
  value: string
  /** Display label, already carrying the "(enforced)"/"(advisory)" suffix. */
  label: string
  description?: string
  enforcement: "enforced" | "advisory"
  /** Advisory postures ride the system prompt → they need a fresh spawn. Native
   *  postures switch live via `setSessionMode` (no restart). */
  restartRequired: boolean
}

/** One route row (catalog-derived, always restart-only). */
export interface RouteRow {
  /** The gateway id a restart-override carries as `route.gateway`. */
  value: string
  label: string
  description?: string
  baseUrl: string | null
  runnable: boolean
  curated: boolean
  /** The `profileRef`s eligible for this route (§1c) — pre-computed by the
   *  catalog so the access chip can pre-select on a route switch. */
  eligibleProfiles: string[]
}

/** One access row — an eligible profile, or the trailing "+ add profile" flow. */
export interface AccessRow {
  /** The `profileRef` a restart-override attaches. Absent on the add-profile row. */
  value?: string
  label: string
  description?: string
  /** True on the "+ add profile" row → opens the @agentproto/auth flow (§3.7). */
  addProfile?: boolean
}

/** The §3.9 capability bundle for one (adapter × model) at the current route. */
export interface ResolvedCapabilities {
  /** Model rows from `mapChangeModelQuickPickItems` (restart-trap flagged). */
  efforts: EffortLevel[]
  postures: PostureRow[]
  routes: RouteRow[]
  methods: AuthMethod[]
}

/**
 * Everything the pure resolver needs. The interactive flow fetches these from
 * the daemon (adapter listing, `catalog_models`, the named-profile store, the
 * #482 advertised `configOptions`/`availableModes`) and hands them in; the
 * resolver never does I/O.
 */
export interface CapabilityResolutionInput {
  adapter: SpawnAdapterInfo
  /** The model to resolve FOR. The picker passes the tentatively-selected model
   *  so the effort chip RE-RESOLVES as the user moves the model chip (SPEC §3.9,
   *  §6 rule 4) — opus → `ultracode` appears, haiku → it's gone. */
  model?: string
  /** Per-model advertised/derived effort sets (ACP `configOptions` ∩ static
   *  superset), keyed by model id. Keyed on `model` precisely so a model change
   *  yields a different set. */
  effortsByModel?: Readonly<Record<string, readonly EffortLevel[]>>
  /** Effort set for a model absent from `effortsByModel` (static-superset
   *  fallback, SPEC §3.9). Omitted ⇒ the effort chip is hidden for that model. */
  defaultEfforts?: readonly EffortLevel[]
  /** The session's advertised native modes (#482 read-surface). */
  availableModes?: readonly HarnessMode[]
  /** `catalog_models` filtered to this adapter (SPEC §5). Supplies route rows. */
  catalog?: CatalogModelsResult
  /** Named auth profiles known to the daemon — for access-row labels/methods. */
  profiles?: readonly AuthProfileRow[]
  /** Context profiles the adapter declares (`kind:"context"` modes, SPEC §3.3);
   *  the client mirror carries no `kind`, so the caller derives + passes them. */
  contextProfiles?: readonly ContextProfile[]
}

// ── Per-axis resolvers ──────────────────────────────────────────────────────

/**
 * The offerable effort labels for the CURRENT model (SPEC §3.9). Model-dependent
 * by construction: the advertised/derived set is keyed on `model`, so calling
 * this with a different `model` returns a different set — that IS the effort
 * chip's re-resolution on model change (SPEC §6 rule 4).
 */
export function resolveEfforts(input: CapabilityResolutionInput): EffortLevel[] {
  const advertised = input.model ? input.effortsByModel?.[input.model] : undefined
  return [...(advertised ?? input.defaultEfforts ?? [])]
}

/**
 * The posture rows = the harness's advertised native modes (enforced, live)
 * UNION the agentproto-canonical postures that have no native equivalent
 * (advisory, prompt-injected) — SPEC §3.4a. Native always wins: a canonical
 * posture the harness advertises natively appears ONCE, as its native
 * (enforced) row, never doubled as an advisory one.
 *
 * Rw labeling is applied here and nowhere else: an enforced row reads
 * "plan (enforced)", an advisory one "plan (advisory)". Even a harness with no
 * modes (hermes) still gets the canonical postures — all advisory.
 */
export function resolvePostureRows(availableModes: readonly HarnessMode[] = []): PostureRow[] {
  const rows: PostureRow[] = []
  const canonicalCovered = new Set<CanonicalPosture>()

  for (const mode of availableModes) {
    const canonical = canonicalForModeId(mode.id)
    if (canonical) canonicalCovered.add(canonical)
    const name = canonical ?? mode.name ?? mode.id
    rows.push({
      // A native mode carrying a canonical meaning sends the canonical value so
      // the daemon maps it back onto whatever this harness spells it; a native
      // mode with no canonical name sends its raw harness id.
      value: canonical ?? mode.id,
      label: `${name} (enforced)`,
      description: mode.description ?? undefined,
      enforcement: "enforced",
      restartRequired: false,
    })
  }

  for (const posture of CANONICAL_POSTURES) {
    if (canonicalCovered.has(posture)) continue
    rows.push({
      value: posture,
      label: `${posture} (advisory)`,
      // Be explicit that this is NOT a permission boundary (SPEC risk Rw).
      description: "prompt-only — advisory, not enforced",
      enforcement: "advisory",
      restartRequired: true,
    })
  }
  return rows
}

/**
 * Strip a model id to its bare product (drop a `vendor/` prefix, a `:pin`, an
 * `@route`) so it can be matched against a catalog `product`.
 */
function productOf(model: string): string {
  const afterVendor = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model
  return afterVendor.split("@")[0]!.split(":")[0]!
}

/** The catalog product entry for `model`, searched across every vendor. */
function findCatalogProduct(
  catalog: CatalogModelsResult | undefined,
  model: string | undefined,
): { vendor: string; product: CatalogProductRow } | undefined {
  if (!catalog || !model) return undefined
  const product = productOf(model)
  for (const vendor of catalog.vendors) {
    const match = vendor.products.find(p => p.product === product || p.product === model)
    if (match) return { vendor: vendor.vendor, product: match }
  }
  return undefined
}

/**
 * The catalog routes offerable for the current model (SPEC §3.9/§5.4). Empty
 * (⇒ chip hidden) when the catalog knows no routes for the model — never a
 * hardcoded gateway list.
 */
export function resolveRouteRows(
  catalog: CatalogModelsResult | undefined,
  model: string | undefined,
): RouteRow[] {
  const found = findCatalogProduct(catalog, model)
  if (!found) return []
  return found.product.routes.map(route => ({
    value: route.route,
    label: route.route,
    description: routeDescription(found.vendor, route),
    baseUrl: route.baseUrl,
    runnable: route.runnable,
    curated: route.curated,
    eligibleProfiles: [...route.eligibleProfiles],
  }))
}

/** A route/model row's description — a non-runnable row names the gap instead of
 *  hiding it (SPEC §6 rendering rule 5), the profile-aware successor to the old
 *  "no key" hint. */
function routeDescription(vendor: string, route: CatalogRouteRow): string {
  if (!route.runnable) return `no eligible ${vendor} profile — add one`
  const parts: string[] = []
  if (!route.curated) parts.push("more routes")
  if (route.baseUrl) parts.push(route.baseUrl)
  return parts.join(" · ")
}

/**
 * The route the session is currently on: the descriptor's explicit `route.gateway`
 * matched against the catalog product's routes (by route id OR `adapterModes`),
 * else the DIRECT route (the model's own vendor, `baseUrl === null`), else the
 * first known route. Undefined when the catalog knows no routes for the model.
 */
export function currentRouteOf(
  descriptor: Pick<SessionDescriptor, "route" | "model">,
  catalog: CatalogModelsResult | undefined,
): RouteRow | undefined {
  const rows = resolveRouteRows(catalog, descriptor.model)
  if (rows.length === 0) return undefined
  const gateway = descriptor.route?.gateway
  if (gateway) {
    const explicit = rows.find(r => r.value === gateway)
    if (explicit) return explicit
    // A gateway named by its adapter-mode id (e.g. "moonshot") resolving to a
    // catalog route whose adapterModes carries it.
    const byMode = rows.find(r =>
      (catalogRouteFor(catalog, descriptor.model, r.value)?.adapterModes ?? []).includes(gateway),
    )
    if (byMode) return byMode
  }
  const direct = rows.find(r => r.baseUrl === null)
  return direct ?? rows[0]
}

function catalogRouteFor(
  catalog: CatalogModelsResult | undefined,
  model: string | undefined,
  routeId: string,
): CatalogRouteRow | undefined {
  return findCatalogProduct(catalog, model)?.product.routes.find(r => r.route === routeId)
}

/**
 * The access rows for the current route: the eligible profiles (§1c) as
 * selectable rows, ALWAYS followed by a "+ add profile" row (the acquisition
 * flow, §3.7) — so a route with no eligible profile still offers the way to add
 * one rather than dead-ending. Also reports whether the session's currently
 * attached profile is no longer eligible on this route (SPEC risk Rx / §6 rule
 * 4): the caller flags it and forces a re-pick, never carries a stale wallet.
 */
export function resolveAccessRows(input: {
  currentRoute: RouteRow | undefined
  profiles?: readonly AuthProfileRow[]
  attachedProfileRef?: string
}): { rows: AccessRow[]; ineligibleAttached?: string } {
  const eligible = new Set(input.currentRoute?.eligibleProfiles ?? [])
  const byId = new Map((input.profiles ?? []).map(p => [p.id, p]))

  const rows: AccessRow[] = [...eligible].map(id => {
    const profile = byId.get(id)
    return {
      value: id,
      label: profile?.label ?? id,
      description: profile ? `${profile.vendor} · ${profile.method}` : undefined,
    }
  })
  rows.push({ label: "+ add profile", addProfile: true })

  const attached = input.attachedProfileRef
  const ineligibleAttached = attached && !eligible.has(attached) ? attached : undefined
  return { rows, ...(ineligibleAttached ? { ineligibleAttached } : {}) }
}

/**
 * The §3.9 capability bundle for the current (adapter × model × route). Pure —
 * the picker calls it once to render, and again with a different `model` to
 * re-resolve effort (and, via `currentRoute`, access) when the user moves the
 * model chip.
 */
export function resolveCapabilities(
  descriptor: Pick<SessionDescriptor, "route" | "model">,
  input: CapabilityResolutionInput,
): ResolvedCapabilities {
  const currentRoute = currentRouteOf({ route: descriptor.route, model: input.model }, input.catalog)
  const eligible = new Set(currentRoute?.eligibleProfiles ?? [])
  const methods = [
    ...new Set(
      (input.profiles ?? []).filter(p => eligible.has(p.id)).map(p => p.method),
    ),
  ]
  return {
    efforts: resolveEfforts(input),
    postures: resolvePostureRows(input.availableModes),
    routes: resolveRouteRows(input.catalog, input.model),
    methods,
  }
}

// ── Chip + action assembly (SPEC §6) ─────────────────────────────────────────

export type ConfigAxis = "model" | "effort" | "route" | "access" | "posture" | "contextProfile"

/** The daemon verb a chip is bound to (SPEC §4.5). */
export type ConfigVerb = "agent_set_model" | "agent_set_effort" | "agent_set_posture" | "session_restart"

export interface ConfigChipRow {
  label: string
  description?: string
  /** The axis value this row selects. */
  value: string
  /** True when picking THIS row needs a restart even on an otherwise-live chip
   *  (the model↔route trap; an advisory posture). */
  restartRequired: boolean
  /** True on the row matching the session's current value for this axis. */
  current?: boolean
  /** posture-only: enforced (native) vs advisory (prompt-injected) — SPEC Rw. */
  enforcement?: "enforced" | "advisory"
  /** access-only: the "+ add profile" acquisition row (§3.7). */
  addProfile?: boolean
}

export interface ConfigChip {
  axis: ConfigAxis
  verb: ConfigVerb
  /** The current value shown on the chip face; undefined ⇒ adapter default. */
  current?: string
  /** True when the chip's apply-path is restart-only (every row restart-tagged);
   *  false for a live chip (model, effort, native posture) — SPEC §6 rule 1. */
  restart: boolean
  /** The persistent "⟲ restart required" affix, set only on a restart-only chip
   *  (SPEC §6 rule 2). A live chip never shows it — the per-row `restartRequired`
   *  carries the model↔route-trap / advisory-posture exception instead. */
  restartAffix?: string
  rows: ConfigChipRow[]
  /** access-only: the attached profile is no longer eligible on the current
   *  route (SPEC risk Rx) — the chip surfaces a re-pick prompt, never a silent
   *  stale wallet. */
  ineligibleAttachedProfile?: string
}

export type SessionActionKind = "interrupt" | "stop"

export interface SessionAction {
  kind: SessionActionKind
  verb: "agent_interrupt" | "session_kill"
  label: string
  description: string
  /** interrupt is enabled only while a turn is in flight (session `busy`); stop
   *  is a terminal action, always enabled (SPEC §4.5). */
  enabled: boolean
}

/** Describe a `Posture` value for the chip face (a canonical string, or a raw
 *  `{harnessModeId}`). */
function describePosture(posture: Posture | undefined): string | undefined {
  if (posture === undefined) return undefined
  return typeof posture === "object" ? posture.harnessModeId : posture
}

/**
 * Build the dynamic config-chip strip for one session (SPEC §6). Each axis is
 * resolved from `resolveCapabilities`; a chip with an EMPTY resolved set is
 * omitted entirely (hidden, not a dead affordance). Order follows the SPEC
 * table: model, effort, route, access, posture, contextProfile.
 */
export function buildSessionConfigChips(
  descriptor: Pick<
    SessionDescriptor,
    "model" | "mode" | "effort" | "posture" | "route" | "contextProfile" | "accessProfile"
  >,
  input: CapabilityResolutionInput,
): ConfigChip[] {
  const chips: ConfigChip[] = []

  // model — live, reuse the existing grouped menu + restart-trap flagging.
  const modelRows: ConfigChipRow[] = mapChangeModelQuickPickItems(input.adapter, {
    model: descriptor.model,
    mode: descriptor.mode,
  })
    .filter(item => item.model !== undefined)
    .map(item => ({
      label: item.label,
      description: item.description,
      value: item.model!,
      restartRequired: item.restartRequired ?? false,
      ...(item.current ? { current: true } : {}),
    }))
  if (modelRows.length > 0) {
    chips.push({
      axis: "model",
      verb: "agent_set_model",
      current: descriptor.model,
      restart: false,
      rows: modelRows,
    })
  }

  // effort — live, model-dependent (re-resolves on model change).
  const efforts = resolveEfforts(input)
  if (efforts.length > 0) {
    chips.push({
      axis: "effort",
      verb: "agent_set_effort",
      current: descriptor.effort,
      restart: false,
      rows: efforts.map(effort => ({
        label: effort,
        value: effort,
        restartRequired: false,
        ...(descriptor.effort === effort ? { current: true } : {}),
      })),
    })
  }

  // route — restart-only, catalog-derived.
  const routes = resolveRouteRows(input.catalog, descriptor.model)
  const currentRoute = currentRouteOf(descriptor, input.catalog)
  if (routes.length > 0) {
    chips.push({
      axis: "route",
      verb: "session_restart",
      current: currentRoute?.value ?? descriptor.route?.gateway,
      restart: true,
      restartAffix: RESTART_AFFIX,
      rows: routes.map(route => ({
        label: route.label,
        description: route.description,
        value: route.value,
        restartRequired: true,
        ...(currentRoute?.value === route.value ? { current: true } : {}),
      })),
    })
  }

  // access — restart-only, route-dependent eligible profiles + add-profile flow.
  const access = resolveAccessRows({
    currentRoute,
    profiles: input.profiles,
    attachedProfileRef: descriptor.accessProfile?.profileRef,
  })
  chips.push({
    axis: "access",
    verb: "session_restart",
    current: descriptor.accessProfile?.label ?? descriptor.accessProfile?.profileRef,
    restart: true,
    restartAffix: RESTART_AFFIX,
    rows: access.rows.map(row => ({
      label: row.label,
      description: row.description,
      value: row.value ?? "",
      restartRequired: true,
      ...(row.addProfile ? { addProfile: true } : {}),
      ...(row.value && descriptor.accessProfile?.profileRef === row.value ? { current: true } : {}),
    })),
    ...(access.ineligibleAttached ? { ineligibleAttachedProfile: access.ineligibleAttached } : {}),
  })

  // posture — live (native) chip, but advisory rows are individually restart-tagged.
  const postures = resolvePostureRows(input.availableModes)
  if (postures.length > 0) {
    const currentPosture = describePosture(descriptor.posture)
    chips.push({
      axis: "posture",
      verb: "agent_set_posture",
      current: currentPosture,
      restart: false,
      rows: postures.map(row => ({
        label: row.label,
        description: row.description,
        value: row.value,
        restartRequired: row.restartRequired,
        enforcement: row.enforcement,
        ...(currentPosture === row.value ? { current: true } : {}),
      })),
    })
  }

  // contextProfile — restart-only toggle.
  const contextProfiles = input.contextProfiles ?? []
  if (contextProfiles.length > 0) {
    chips.push({
      axis: "contextProfile",
      verb: "session_restart",
      current: descriptor.contextProfile,
      restart: true,
      restartAffix: RESTART_AFFIX,
      rows: contextProfiles.map(profile => ({
        label: String(profile),
        value: String(profile),
        restartRequired: true,
        ...(descriptor.contextProfile === profile ? { current: true } : {}),
      })),
    })
  }

  return chips
}

/**
 * The two session ACTIONS that ride the same strip after the config chips (SPEC
 * §4.5): interrupt (cancels the in-flight turn, session survives — enabled ONLY
 * while `busy`) and stop (kills the session — always). Neither is a
 * `SessionConfig` axis; they carry no state to round-trip (SPEC §3.8).
 */
export function buildSessionActions(
  descriptor: Pick<SessionDescriptor, "busy">,
): SessionAction[] {
  return [
    {
      kind: "interrupt",
      verb: "agent_interrupt",
      label: "Interrupt",
      description: "cancel the in-flight turn — the session stays alive",
      enabled: descriptor.busy === true,
    },
    {
      kind: "stop",
      verb: "session_kill",
      label: "Stop",
      description: "end this session",
      enabled: true,
    },
  ]
}
