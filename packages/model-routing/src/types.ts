/**
 * AIP-57 MODEL-ROUTING — core types.
 *
 * @see https://agentproto.sh/docs/aip-57
 */

// ── Route (§1) ───────────────────────────────────────────────────────────

/**
 * A resolution target. Every Route MUST be expressible as a valid AIP-42
 * `ModelRef`.
 *
 * Implementations MAY carry verified capability metadata alongside a Route
 * (context window, max output tokens, …) by extending this interface — see
 * the generic `R extends Route` parameter threaded through {@link Pack},
 * {@link Layer} and {@link ResolvedRoute}. Per §1, such fields MUST be
 * absent rather than guessed when unverified.
 */
export interface Route {
  /** Provider-native model id. */
  model: string
  /** Omitted ⇒ inferred from `model` or the layer, by the host — never by `resolve`. */
  provider?: string
  version?: string
  /** temperature, max_tokens, … */
  options?: Record<string, unknown>
  /**
   * Ordered failover rungs (§6). Distinct from a chain (§5): a rung is only
   * taken on a failure of the preceding entry, and taking one MUST NOT
   * change the sticky selection for later turns of the same conversation.
   * Purely descriptive data — `resolve` never taking action on it is what
   * keeps §7 purity: failure detection and retry are a host concern.
   */
  fallbacks?: readonly Route[]
  /** Human rationale; never consumed by resolution. */
  note?: string
}

/** A Route, or `null` to declare a key explicitly unavailable (§4). */
export type RouteOrGate = Route | null

// ── Pack (§2) ────────────────────────────────────────────────────────────

/**
 * `"model"` and `"role"` are reserved keyspace names; others MAY be
 * declared. The `(string & {})` half keeps the two reserved literals as
 * editor suggestions without narrowing the type to only those two.
 */
export type Keyspace = "model" | "role" | (string & {})

/**
 * A named, TOTAL map from a declared keyspace to a route. Totality is
 * enforced structurally: `Record<Key, R | null>` requires every literal in
 * the `Key` union to be present, so an incomplete pack is a compile error,
 * not a runtime lookup miss. Absence and `null` are not synonyms — see §4.
 */
export interface Pack<Key extends string = string, R extends Route = Route> {
  id: string
  label: string
  description?: string
  /** What the keys mean. */
  keyspace: Keyspace
  routes: Readonly<Record<Key, R | null>>
}

// ── Layers and resolution (§3, §4) ──────────────────────────────────────

/** The three reserved layer sources, highest precedence first. */
export type ReservedSource = "override" | "env" | "pack"

/**
 * `source` is open past the three reserved values: §3 permits additional
 * layers, and requires them to extend `source` rather than collapse into
 * one of the reserved three.
 */
export type Source = ReservedSource | (string & {})

/**
 * One precedence layer above the pack. `pack.routes` is always the implicit
 * lowest-precedence layer — it is total, so it always has an answer.
 *
 * A layer's `entries` are keys it names EXPLICITLY; `catchAll` is its
 * fallback for keys it does not name. The explicit/catch-all distinction is
 * what §4's gate rule hinges on: a catch-all must not re-enable a key a
 * lower-or-equal layer gated to `null`, but an explicit entry always can.
 */
export interface Layer<Key extends string = string, R extends Route = Route> {
  source: Source
  entries?: Partial<Readonly<Record<Key, R | null>>>
  catchAll?: R
}

/**
 * The result of `resolve` (§3). `source` is normative, not diagnostic — it
 * MUST always be reported, per §3's rationale: "a routing decision that
 * cannot say which layer won is not auditable."
 */
export type ResolvedRoute<R extends Route = Route> = R & {
  key: string
  source: Source
  /**
   * Present only when resolution passed through a §5 chain: the virtual
   * key the client originally addressed, distinct from `key` (the served
   * model's real key). Surfacing both is what §5 means by "the served
   * model identity MUST be reattached once, immutably" — `key` is what
   * metrics/pricing/outbound bodies must observe; `virtualKey` is what the
   * client addressed and what a host MAY echo back (e.g. `x-served-model`).
   */
  virtualKey?: string
}

// ── Chains (§5) ──────────────────────────────────────────────────────────

/**
 * A named ordered chain of candidate refs into the same routing space.
 * Distributes a population of conversations across candidates — not a
 * failover list (§6 `Route.fallbacks` is that).
 */
export interface Chain {
  id: string
  /** ≥2 refs into the same routing space. MUST NOT reference another chain — see `defineChain`. */
  chain: readonly string[]
}

/** The outcome of sticky chain selection (§5), before the served key is resolved to a Route. */
export interface ChainResolution {
  readonly id: string
  readonly servedKey: string
}

// ── Sticky prefix inputs (§5) ────────────────────────────────────────────

/** The minimal message shape `stablePrefix` needs. Extra fields pass through untouched. */
export interface RoutableMessage {
  readonly role: string
}

/** The minimal request shape `stablePrefix` needs. */
export interface RoutableRequest {
  readonly messages: readonly RoutableMessage[]
}
