/**
 * AIP-54 REF — `RefCatalog` + `refFor` reference implementation.
 *
 * The join between AIP-43 registries and the canonical `ArtifactRef`.
 * A catalog is boot-time-stable: families are registered up front, one
 * per AIP whose artifacts get referenced. Resolution is a Map lookup —
 * no filesystem, no HTTP, all I/O (if a host wants it) via the
 * registries themselves.
 */

import {
  RefFamilyError,
  RefUnresolvableError,
  type ArtifactRef,
  type FamilySpec,
  type RefKeyableHandle,
  type RefRegistryLike,
  type ResolvedArtifact,
} from "./artifact-ref.js"

/** Default key resolution, mirroring AIP-43 § Identity exactly. */
function defaultKeyBy(handle: RefKeyableHandle): string | undefined {
  if (typeof handle.id === "string" && handle.id.length > 0) return handle.id
  if (typeof handle.provider === "string" && handle.provider.length > 0)
    return handle.provider
  if (typeof handle.slug === "string" && handle.slug.length > 0) return handle.slug
  if (typeof handle.name === "string" && handle.name.length > 0) return handle.name
  return undefined
}

function validateRef(ref: ArtifactRef): void {
  if (!Number.isInteger(ref.aip) || ref.aip < 1) {
    throw new TypeError(`@agentproto/ref (AIP-54): ref.aip must be a positive integer, got ${ref.aip}`)
  }
  if (typeof ref.id !== "string" || ref.id.length === 0) {
    throw new TypeError(`@agentproto/ref (AIP-54): ref.id must be a non-empty string`)
  }
}

export interface RefCatalogOptions {
  /**
   * Resolution failure mode. `"return-undefined"` (default) lets
   * callers branch; `"throw"` raises `RefUnresolvableError` instead —
   * for hosts that treat dangling refs as HARD failures.
   */
  readonly onUnresolvable?: "return-undefined" | "throw"
}

export class RefCatalog {
  private byAip = new Map<number, { family: string; registry: RefRegistryLike; keyBy: (h: never) => string }>()

  constructor(private readonly opts: RefCatalogOptions = {}) {}

  /**
   * Register the registry that owns one AIP's artifacts. Re-registering
   * the same aip replaces the previous binding (hot-reload parity with
   * AIP-43's `replace`).
   */
  registerFamily<H>(aip: number, spec: FamilySpec<H>, registry: RefRegistryLike): void {
    this.byAip.set(aip, {
      family: spec.family,
      registry,
      keyBy: (spec.keyBy ?? defaultKeyBy) as (h: never) => string,
    })
  }

  /** The family name bound to `aip`, if any. */
  familyOf(aip: number): string | undefined {
    return this.byAip.get(aip)?.family
  }

  /**
   * Resolve a ref to the real handle. Returns undefined (or throws,
   * per options) for unknown aip or unknown id — a dangling id string
   * never masquerades as a resolution.
   */
  resolve(ref: ArtifactRef): ResolvedArtifact | undefined {
    validateRef(ref)
    const entry = this.byAip.get(ref.aip)
    if (!entry) {
      if (this.opts.onUnresolvable === "throw") throw new RefFamilyError(ref.aip)
      return undefined
    }
    const handle = entry.registry.get(ref.id)
    if (handle === undefined) {
      if (this.opts.onUnresolvable === "throw")
        throw new RefUnresolvableError(ref, entry.family)
      return undefined
    }
    return { handle, family: entry.family }
  }

  /** Throws (RefFamilyError/RefUnresolvableError) instead of returning undefined. */
  resolveStrict(ref: ArtifactRef): ResolvedArtifact {
    const hit = this.resolve(ref)
    if (!hit) {
      const entry = this.byAip.get(ref.aip)
      if (!entry) throw new RefFamilyError(ref.aip)
      throw new RefUnresolvableError(ref, entry.family)
    }
    return hit
  }

  /** Every handle registered in one family — how "a collection of priced things" is built. */
  familyOfHandles(aip: number): readonly unknown[] {
    return this.byAip.get(aip)?.registry.list() ?? []
  }
}

/**
 * Derive a typed ref from a spec + handle. The spec's keyBy MUST be the
 * same function the family's registry uses, so a ref's id can never
 * drift from its registry key. Throws when the handle has no key at all
 * (e.g. an anonymous AIP-42 app — such handles cannot be referenced).
 */
export function refFor<A extends number, H extends RefKeyableHandle>(
  spec: { readonly aip: A; readonly keyBy?: (h: H) => string },
  handle: H,
  version?: string,
): ArtifactRef<A> {
  const key = spec.keyBy
    ? spec.keyBy(handle)
    : defaultKeyBy(handle)
  if (!key) {
    throw new Error(
      `@agentproto/ref (AIP-54): handle has no registry key (id/provider/slug/name all empty) — it cannot be referenced. Anonymous handles are unreferenceable.`,
    )
  }
  return Object.freeze({ aip: spec.aip, id: key, ...(version ? { version } : {}) })
}

/** URI serialization for YAML/JSON-string contexts: `aip://<aip>/<id>[@version]`. */
export function refToUri(ref: ArtifactRef): string {
  return `aip://${ref.aip}/${ref.id}${ref.version ? `@${ref.version}` : ""}`
}

/** Parse an `aip://` URI back into a ref. Throws on malformed input. */
export function refFromUri(uri: string): ArtifactRef {
  const m = /^aip:\/\/(\d+)\/([^@\s]+)(?:@(.+))?$/.exec(uri)
  if (!m || m[2] === undefined) throw new Error(`@agentproto/ref (AIP-54): malformed aip:// URI: ${uri}`)
  const ref: ArtifactRef = { aip: Number(m[1]!), id: m[2] }
  if (m[3] !== undefined) return { ...ref, version: m[3] }
  return ref
}
