/**
 * AIP-47 built-in role source.
 *
 * Wraps an AIP-43 `@agentproto/registry` instance keyed by role slug.
 * Intended primarily for runtime-shipped catalogues
 * (`@agentproto/role-catalog`, vendor-specific registries) where the
 * roles are authored in TS and validated at module load time. The
 * registry is mutable post-construction — `register` / `unregister` /
 * `replace` let downstream apps extend the catalogue without forking
 * the OSS package.
 *
 * Refs are matched in three forms:
 *   - bare slug:          `seo-specialist`
 *   - scoped slug:        `builtin/seo-specialist`
 *   - ws:// ref:          `ws://roles/seo-specialist`
 *
 * All three resolve to the same entry. The `scheme` is `builtin`.
 */

import { createRegistry, type Registry } from "@agentproto/registry"
import type {
  BuiltinRoleEntry,
  RoleManifestRaw,
  RoleRef,
  RoleSource,
} from "./types.js"

const WS_REF_PREFIX = "ws://roles/"
const BUILTIN_PREFIX = "builtin/"
const REGISTRY_FAMILY = "role-builtin"

function normaliseSlug(ref: RoleRef): string {
  if (ref.startsWith(WS_REF_PREFIX)) return ref.slice(WS_REF_PREFIX.length)
  if (ref.startsWith(BUILTIN_PREFIX)) return ref.slice(BUILTIN_PREFIX.length)
  return ref
}

export class BuiltinRoleSource implements RoleSource {
  readonly scheme = "builtin"

  /**
   * Underlying AIP-43 registry. Exposed for advanced consumers that
   * want to use `lookup(predicate)`, `entries()`, or other registry
   * primitives. The common operations are mirrored on the source
   * itself for ergonomics.
   */
  readonly registry: Registry<BuiltinRoleEntry>

  constructor(entries: Iterable<BuiltinRoleEntry> = []) {
    this.registry = createRegistry<BuiltinRoleEntry>({
      family: REGISTRY_FAMILY,
      keyBy: (e) => e.slug,
    })
    for (const e of entries) {
      this.registry.register(e)
    }
  }

  async load(ref: RoleRef): Promise<RoleManifestRaw | null> {
    const slug = normaliseSlug(ref)
    const entry = this.registry.get(slug)
    if (!entry) return null
    return {
      ref: `builtin/${slug}`,
      frontmatter: entry.handle,
      body: entry.body ?? "",
      scheme: "builtin",
    }
  }

  async list(): Promise<readonly RoleRef[]> {
    return this.registry.list().map((e) => `builtin/${e.slug}`)
  }

  /* ─── mutation surface (AIP-43 primitive operations) ─────────── */

  /**
   * Register a new builtin entry. Throws `RegistryDuplicateError`
   * if a handle with the same slug is already registered — use
   * `replace` to swap atomically when a hot-reload picks up a
   * redefined role.
   */
  register(entry: BuiltinRoleEntry): void {
    this.registry.register(entry)
  }

  /**
   * Replace an existing entry. Throws `RegistryNotFoundError` if no
   * entry exists at the resolved slug. Use `register` for new slugs.
   */
  replace(entry: BuiltinRoleEntry): void {
    this.registry.replace(entry)
  }

  /**
   * Remove a slug from the registry. Returns true if an entry was
   * removed. Use sparingly — the registry is intended to be
   * boot-time-stable.
   */
  unregister(slug: string): boolean {
    return this.registry.unregister(normaliseSlug(slug))
  }

  /** Returns true if the slug (any ref form) is registered. */
  has(slug: string): boolean {
    return this.registry.has(normaliseSlug(slug))
  }

  /** Number of entries currently registered. */
  count(): number {
    return this.registry.count()
  }

  /**
   * Filter entries by an arbitrary predicate. Runs in registration
   * order. Useful for capability lookups like "every role with
   * `metadata.aip-47.audience === 'ai-worker'`".
   */
  lookup(
    predicate: (entry: BuiltinRoleEntry) => boolean,
  ): readonly BuiltinRoleEntry[] {
    return this.registry.lookup(predicate)
  }
}

/**
 * Convenience: assemble a `BuiltinRoleSource` from a record map.
 * Each entry's key becomes the slug.
 */
export function builtinSourceFromRecord(
  record: Record<string, Omit<BuiltinRoleEntry, "slug">>,
): BuiltinRoleSource {
  return new BuiltinRoleSource(
    Object.entries(record).map(([slug, rest]) => ({ slug, ...rest })),
  )
}
