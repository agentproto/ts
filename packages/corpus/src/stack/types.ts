/**
 * Knowledge-stack layer model (AIP-10 §Composition).
 *
 * A knowledge stack is the ordered set of layers an operator's recall is
 * resolved against: its own packs, its role's packs, an org house-style
 * view, a regional compliance floor, and so on. Each layer is produced by
 * a registered `LayerProvider` — adding a dimension (region, compliance,
 * tier, …) is registering one provider, never editing the resolver.
 *
 * The model has two knobs:
 *   - `band`  — precedence among LENS layers (lower = higher precedence).
 *   - `mode`  — `lens` (overridable) vs `constraint` (a non-shadowable,
 *               non-tombstoneable floor; see AIP-10).
 *
 * Vendor-neutral: a provider reads a generic `ResolutionContext` and emits
 * `LayerRef`s the host knows how to mount. The context carries dimension
 * values plus an opaque, host-typed `subject` (an operator row, a role
 * handle, …) so per-app providers stay type-safe without leaking app
 * types into the kit.
 */

/** How a layer composes against the others. */
export type LayerMode = "lens" | "constraint"

/** A pointer to a mountable knowledge source — a pack id or a view ref. */
export interface LayerRef {
  /** Pack id (`screen-cv`) or KNOWLEDGE.md view ref (`region/fr`). */
  readonly ref: string
  /** How the host should resolve `ref`. Defaults to `pack`. */
  readonly kind?: "pack" | "view"
}

/**
 * What the resolver is given. `subject` is opaque to the kit; providers
 * narrow it. `dimensions` is the open facet bag (`region`, `compliance`,
 * `org`, `tier`, `locale`, …).
 */
export interface ResolutionContext<TSubject = unknown> {
  /** Stable bucketing token for shadow rollout (e.g. conversation id). */
  readonly conversationId?: string
  /** Dimension values keyed by dimension name. Missing/undefined = absent.
   * List-valued dimensions (e.g. `capability`) carry every value at once —
   * providers that expect a scalar must guard. */
  readonly dimensions?: Readonly<
    Record<string, string | readonly string[] | undefined>
  >
  /** Host payload providers read to compute their refs. */
  readonly subject?: TSubject
}

/** Optional shadow-rollout config for a layer. */
export interface LayerShadow {
  /** Fraction of conversations the layer fires on (0..1). */
  readonly pct?: number
}

/**
 * A pluggable layer. Behavior lives on the descriptor — the resolver never
 * branches on `id` or `dimension`. Register via
 * `createRegistry<LayerProvider>({ family, keyBy: p => p.id })`.
 */
export interface LayerProvider<TSubject = unknown> {
  /** Registry key. */
  readonly id: string
  /** Precedence among lenses; lower wins. Constraints are hoisted regardless. */
  readonly band: number
  /** `lens` (overridable) or `constraint` (floor). */
  readonly mode: LayerMode
  /** Dimension this layer adapts (`operator`, `role`, `region`, …) for audit. */
  readonly dimension?: string
  /** When set, the layer is a shadow arm sampled deterministically. */
  readonly shadow?: LayerShadow
  /** Compute the layer's refs for a context. Empty → the layer is inert. */
  resolve(
    ctx: ResolutionContext<TSubject>
  ): readonly LayerRef[] | Promise<readonly LayerRef[]>
}

/** One resolved layer in the stack, carrying audit attribution. */
export interface StackEntry {
  readonly providerId: string
  readonly band: number
  readonly mode: LayerMode
  readonly dimension?: string
  readonly refs: readonly LayerRef[]
  /** True iff this layer was a shadow arm that sampled in for this context. */
  readonly shadowSampled: boolean
}

/** The resolved stack + the audit trail of layers that did NOT contribute. */
export interface StackResolution {
  /** Contributing layers, band-ordered (constraints keep their band here; the
   *  mount step hoists them). */
  readonly entries: readonly StackEntry[]
  /** Providers that resolved to nothing or sampled out, for "why not" audits. */
  readonly skipped: readonly StackSkip[]
}

export interface StackSkip {
  readonly providerId: string
  readonly dimension?: string
  readonly reason: "empty" | "shadow-not-sampled"
}
