/**
 * AIP-54 REF — public types.
 *
 * `ArtifactRef` is the canonical typed cross-AIP reference: one shape
 * any AIP artifact can use to point at any OTHER AIP artifact. It
 * replaces the ad-hoc per-primitive reference fields (AIP-18's
 * collection-scoped `refKind`, app-kit's inline `DoctypeHandle`,
 * AIP-55's draft `appRef`/`packRef`, AIP-42's bare `AnyRef` strings,
 * AIP-52's `$resolver`) with one discriminated, resolvable object.
 *
 * Resolution is delegated to per-family AIP-43 registries, joined by
 * the `RefCatalog`. The catalog owns the aip → (family, registry)
 * table; the ref itself is inert data and carries no behavior.
 */

/**
 * Canonical typed reference to one AIP artifact.
 *
 * `aip` is the owning AIP number and the type discriminator: it names
 * the registry family the id resolves against. `id` is that family's
 * registry key (usually the handle's `id`, but the family's `keyBy`
 * decides — e.g. packs key on `name`). `version` pins the artifact;
 * absent means floating.
 */
export interface ArtifactRef<A extends number = number> {
  readonly aip: A
  readonly id: string
  readonly version?: string
}

/** Minimal registry surface `RefCatalog` needs (AIP-43 superset-safe). */
export interface RefRegistryLike {
  get(id: string): unknown
  list(): readonly unknown[]
}

/** A resolved reference: the real handle plus the family it came from. */
export interface ResolvedArtifact {
  readonly handle: unknown
  readonly family: string
}

/** Shape a family spec must satisfy to register with a RefCatalog. */
export interface FamilySpec<H> {
  /** Human-readable family name, used in error messages. */
  readonly family: string
  /**
   * How to derive the ref id from a handle of this family. Omit to use
   * the AIP-43 default resolution (handle.id ?? provider ?? slug).
   * This MUST match the keyBy the family's registry itself uses, or
   * refs and registry keys drift.
   */
  readonly keyBy?: (handle: H) => string
}

/** Identity fields every AIP doctype handle carries under some name. */
export type RefKeyableHandle = {
  id?: string
  name?: string
  slug?: string
  provider?: string
}

/** Thrown when a ref names a family (aip) that has no registered registry. */
export class RefFamilyError extends Error {
  constructor(
    readonly aip: number,
  ) {
    super(`ref-catalog (AIP-54): no registry registered for aip ${aip} — call registerFamily() first`)
    this.name = "RefFamilyError"
  }
}

/** Thrown when a ref resolves to a family whose registry lacks the id. */
export class RefUnresolvableError extends Error {
  constructor(
    readonly ref: ArtifactRef,
    family: string,
  ) {
    super(
      `ref-catalog (AIP-54): ref aip://${ref.aip}/${ref.id} does not resolve in family '${family}'`,
    )
    this.name = "RefUnresolvableError"
  }
}
