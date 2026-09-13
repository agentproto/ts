/**
 * Auth / model mind map — the pure view-model builder.
 *
 * Turns the daemon's live introspection (auth profiles, adapter manifests,
 * harness capabilities, llm-endpoint status) into the small graph the mind map
 * renders: harnesses on one side, providers + their wallets on the other, a
 * local-router relay between them, and a `reach` classification on every
 * harness→provider edge. No VS Code, no DOM, no I/O — so the rules below are
 * unit-tested against fixtures rather than a running daemon.
 *
 * `reach` is COMPUTED from manifest fields, never hand-set per harness:
 *   - `routeSelection: "free"` (the daemon's flag for an adapter that speaks
 *     Anthropic and can re-point its base_url) → NATIVE to the anthropic
 *     endpoint, VIA-ROUTER to any other (the base_url is aimed at the local
 *     llm-endpoint, which bridges the non-Anthropic upstream).
 *   - `routeSelection: "derived-from-model"` → the endpoint falls out of the
 *     model's vendor prefix, so each reachable provider is NATIVE.
 *   - `routeSelection` absent → a fixed single-provider adapter; its provider
 *     is NATIVE, and the harness is badged `fixed`.
 *
 * Known seams (data the daemon does not expose today — seeded into
 * `AuthModelView.seams` so the UI can surface them honestly rather than
 * silently drop them):
 *   - BLOCKED edges (e.g. hermes denies `anthropic/*`): the deny globs live in
 *     the static manifest and are not projected over `adapter_list` /
 *     `harness_capabilities`, so a denied provider renders as simply
 *     unreachable rather than an explicit red "blocked" edge.
 *   - Router PACK list: only the running llm-endpoint proxy (:18090) serves
 *     `/v1/packs`; the daemon has no route, so we show relay status, not packs.
 *   - ASSIGNED wallet+model per harness: there is no persisted harness→profile
 *     binding (a profile is chosen per spawn), so the map shows reachability,
 *     not a current assignment.
 */

import type {
  AdapterInfo,
  AuthMethod,
  AuthProfileSummary,
  HarnessCapabilities,
  LlmEndpointStatusResult,
  ProfileKeyStatus,
} from "../client/types.js"

/** How a wallet bills — first-class, derived from (method × source). */
export type AccessKind = "subscription-refreshing" | "subscription-stored" | "api-key"

/** How a harness reaches a provider. `blocked` is defined but not yet emitted
 *  (see the deny-glob seam above); kept in the union so the renderer's colour
 *  map and a future daemon projection line up without a type change. */
export type ReachState = "native" | "via-router" | "fixed" | "blocked"

/** A harness's route posture, surfaced as a badge. */
export type RoutePosture = "free" | "derived-from-model" | "fixed"

/** The default number of provider columns shown before the "more" fold. */
export const DEFAULT_PROVIDER_COUNT = 6

export interface WalletView {
  id: string
  label: string
  endpoint: string
  accessKind: AccessKind
  method: AuthMethod
  keyStatus?: ProfileKeyStatus
  /** Non-secret credential descriptor, e.g. "source · claude-code-oauth",
   *  "key ····4f2a", or "credentialRef". Never the secret. */
  credential: string
  /** Human model-curation summary, e.g. "6 allowed" / "all models". */
  models: string
  disabled: boolean
}

export interface ProviderView {
  endpoint: string
  /** Native wire protocol label, e.g. "Anthropic" / "OpenAI-compatible". */
  native: string
  wallets: WalletView[]
  subscriptionCount: number
  apiKeyCount: number
  /** True for the default-visible columns; false ⇒ behind the "more" fold. */
  primary: boolean
}

export interface HarnessView {
  slug: string
  /** Interface the harness itself speaks. */
  speaks: "Anthropic" | "OpenAI" | "Anthropic + OpenAI" | "derived"
  route: RoutePosture
  acceptsBaseUrl: boolean
  /** endpoint → reach state, only for providers this harness can reach. */
  reach: Record<string, ReachState>
}

export interface RouterView {
  running: boolean
  healthy: boolean
  baseUrl: string | null
  port: number | null
  status: LlmEndpointStatusResult["status"]
}

export interface AuthModelView {
  harnesses: HarnessView[]
  providers: ProviderView[]
  router: RouterView
  /** Honest notes about data the daemon does not expose (see module header). */
  seams: string[]
}

export interface AuthModelInput {
  adapters: AdapterInfo[]
  capabilities: HarnessCapabilities[]
  profiles: AuthProfileSummary[]
  router: LlmEndpointStatusResult | null
}

/** (method × source) → the wallet's access kind. A source-backed oauth profile
 *  self-refreshes; a credentialRef-backed one is a stored bearer; api-key is a
 *  key regardless. Mirrors the daemon's keyStatus derivation. */
export function accessKind(p: AuthProfileSummary): AccessKind {
  if (p.method === "api-key") return "api-key"
  return p.source ? "subscription-refreshing" : "subscription-stored"
}

/** Non-secret one-line credential descriptor for a wallet card. */
function credentialLabel(p: AuthProfileSummary): string {
  if (p.source) return `source · ${p.source}`
  if (p.keyStatus === "stored" && p.last4) return `key ····${p.last4}`
  if (p.credentialRef) return "stored credential"
  if (p.keyStatus === "unavailable") return "unavailable"
  return "stored credential"
}

function modelsLabel(p: AuthProfileSummary): string {
  if (!p.models || p.models.mode === "all") return "all models"
  return `${p.models.ids.length} allowed`
}

/** A readable native-protocol label for a provider endpoint, from the apiMode
 *  its harnesses report (falling back to a name heuristic when unreported). */
function nativeLabel(endpoint: string, apiMode: "anthropic" | "chat_completions" | undefined): string {
  if (apiMode === "anthropic") return "Anthropic"
  if (apiMode === "chat_completions") return "OpenAI-compatible"
  if (endpoint === "anthropic") return "Anthropic"
  if (endpoint === "openai") return "OpenAI"
  return "OpenAI-compatible"
}

/** The set of billing endpoints a harness can reach, unioned from its live
 *  capability providers, its adapter's model-detail providers, and the
 *  adapter-level `provider` (the endpoint the CLI's own auth bills — how a
 *  generic ACP adapter with no model list, e.g. mistral-vibe, still links
 *  to its provider's wallets). */
function providerSet(adapter: AdapterInfo | undefined, cap: HarnessCapabilities | undefined): Set<string> {
  const out = new Set<string>()
  for (const pr of cap?.providers ?? []) out.add(pr.billingEndpoint ?? pr.id)
  for (const md of adapter?.modelDetails ?? []) if (md.provider) out.add(md.provider)
  if (adapter?.provider) out.add(adapter.provider)
  return out
}

function routePosture(adapter: AdapterInfo | undefined): RoutePosture {
  if (adapter?.routeSelection === "free") return "free"
  if (adapter?.routeSelection === "derived-from-model") return "derived-from-model"
  return "fixed"
}

function speaksOf(adapter: AdapterInfo | undefined, cap: HarnessCapabilities | undefined): HarnessView["speaks"] {
  const anthropic = Boolean(cap?.endpointCompat?.anthropic) || adapter?.routeSelection === "free"
  const openai = Boolean(cap?.endpointCompat?.openai)
  if (anthropic && openai) return "Anthropic + OpenAI"
  if (anthropic) return "Anthropic"
  // No endpointCompat: infer from the providers' native protocol.
  const modes = new Set((cap?.providers ?? []).map(p => p.apiMode).filter(Boolean))
  if (openai || modes.has("chat_completions")) return "OpenAI"
  if (modes.has("anthropic")) return "Anthropic"
  return "derived"
}

/**
 * Classify one harness→provider edge. Returns null when the harness cannot
 * reach the provider at all (no edge drawn).
 *
 * Only two edge states are emitted today — `native` and `via-router` — because
 * they are the two the live manifest actually distinguishes:
 *   - A `free`/Anthropic-speaking harness talks the Anthropic wire natively to
 *     the `anthropic` endpoint; to reach ANY other upstream it re-points its
 *     base_url at the local llm-endpoint, which bridges it → `via-router`.
 *     (The router is the product's real bridge for non-Anthropic upstreams —
 *     that is what `llm-endpoint` exists for — so we don't second-guess it into
 *     a "direct" native edge even when the upstream happens to emulate
 *     Anthropic.)
 *   - Every other harness derives its endpoint from the model's vendor prefix
 *     (or is a fixed single-provider adapter), reaching each provider on that
 *     provider's own wire → `native`.
 * The `free` / `derived-from-model` / `fixed` distinction is NOT flattened into
 * the edge; it is surfaced separately as the harness's route badge, so
 * `codex → openai` correctly reads as a native edge from a fixed-route harness
 * rather than a misleading "fixed" edge. `fixed`/`blocked` remain in
 * {@link ReachState} for a future daemon projection (see the deny-glob seam).
 */
export function reach(
  adapter: AdapterInfo | undefined,
  cap: HarnessCapabilities | undefined,
  endpoint: string,
): ReachState | null {
  const set = providerSet(adapter, cap)
  if (!set.has(endpoint)) return null

  const posture = routePosture(adapter)
  const acceptsBaseUrl = Boolean(cap?.endpointCompat?.anthropic || cap?.endpointCompat?.openai) || posture === "free"

  if (posture === "free" || (acceptsBaseUrl && speaksOf(adapter, cap) === "Anthropic")) {
    return endpoint === "anthropic" ? "native" : "via-router"
  }
  return "native"
}

/** Group live auth profiles into provider columns, deriving per-wallet access
 *  kinds and per-provider access-kind tallies. Providers are ordered by wallet
 *  count (busiest first); the first {@link DEFAULT_PROVIDER_COUNT} are primary,
 *  the rest fold behind a "more" affordance. */
export function buildProviders(
  profiles: AuthProfileSummary[],
  apiModeByEndpoint: Map<string, "anthropic" | "chat_completions" | undefined>,
): ProviderView[] {
  const byEndpoint = new Map<string, WalletView[]>()
  for (const p of profiles) {
    const kind = accessKind(p)
    const wallet: WalletView = {
      id: p.id,
      label: p.label || p.id,
      endpoint: p.endpoint,
      accessKind: kind,
      method: p.method,
      keyStatus: p.keyStatus,
      credential: credentialLabel(p),
      models: modelsLabel(p),
      disabled: Boolean(p.disabled),
    }
    const list = byEndpoint.get(p.endpoint) ?? []
    list.push(wallet)
    byEndpoint.set(p.endpoint, list)
  }

  const providers: ProviderView[] = [...byEndpoint.entries()].map(([endpoint, wallets]) => ({
    endpoint,
    native: nativeLabel(endpoint, apiModeByEndpoint.get(endpoint)),
    wallets,
    subscriptionCount: wallets.filter(w => w.accessKind !== "api-key").length,
    apiKeyCount: wallets.filter(w => w.accessKind === "api-key").length,
    primary: false,
  }))

  // Busiest providers first (more wallets ⇒ more worth showing up front), then
  // stable by endpoint name so the order is deterministic across refreshes.
  providers.sort((a, b) => b.wallets.length - a.wallets.length || a.endpoint.localeCompare(b.endpoint))
  providers.forEach((p, i) => {
    p.primary = i < DEFAULT_PROVIDER_COUNT
  })
  return providers
}

/** Build the whole mind-map view-model from the daemon's live introspection. */
export function buildAuthModel(input: AuthModelInput): AuthModelView {
  const adapterBySlug = new Map(input.adapters.map(a => [a.slug, a]))
  const capBySlug = new Map(input.capabilities.map(c => [c.adapter, c]))
  const slugs = new Set<string>([...adapterBySlug.keys(), ...capBySlug.keys()])

  // A provider's native protocol is whatever apiMode any harness reports for it.
  const apiModeByEndpoint = new Map<string, "anthropic" | "chat_completions" | undefined>()
  for (const cap of input.capabilities) {
    for (const pr of cap.providers ?? []) {
      const ep = pr.billingEndpoint ?? pr.id
      if (pr.apiMode && !apiModeByEndpoint.get(ep)) apiModeByEndpoint.set(ep, pr.apiMode)
    }
  }

  const providers = buildProviders(input.profiles, apiModeByEndpoint)
  const endpoints = providers.map(p => p.endpoint)

  const harnesses: HarnessView[] = [...slugs].sort().map(slug => {
    const adapter = adapterBySlug.get(slug)
    const cap = capBySlug.get(slug)
    const reachMap: Record<string, ReachState> = {}
    for (const ep of endpoints) {
      const state = reach(adapter, cap, ep)
      if (state) reachMap[ep] = state
    }
    return {
      slug,
      speaks: speaksOf(adapter, cap),
      route: routePosture(adapter),
      acceptsBaseUrl: Boolean(cap?.endpointCompat?.anthropic || cap?.endpointCompat?.openai) || adapter?.routeSelection === "free",
      reach: reachMap,
    }
  })

  const router: RouterView = {
    running: Boolean(input.router?.running),
    healthy: Boolean(input.router?.healthy),
    baseUrl: input.router?.baseUrl ?? null,
    port: input.router?.port ?? null,
    status: input.router?.status ?? "never-started",
  }

  const seams = [
    "Blocked edges (deny globs, e.g. hermes → anthropic) aren't projected by the daemon — a denied provider shows as unreachable, not an explicit block.",
    "Router pack list is served only by the running llm-endpoint proxy (:18090/v1/packs); this view shows relay status, not packs.",
    "No persisted harness→wallet binding exists, so edges show reachability, not the currently-assigned wallet+model.",
  ]

  return { harnesses, providers, router, seams }
}
