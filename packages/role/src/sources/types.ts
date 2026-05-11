/**
 * AIP-47 source loader interface.
 *
 * A `RoleSource` resolves a role ref (slug, ws:// ref, file path, http
 * URL) to a raw manifest (frontmatter + body). The resolver assembles
 * the `extends` chain by querying a list of sources in order, first
 * match wins.
 *
 * The interface is intentionally minimal:
 *   - `scheme` — the scheme this source claims (used by the chain to
 *     dispatch by `<scheme>://...` refs)
 *   - `load(ref)` — return the parsed manifest, or `null` if not found
 *
 * Sources MUST enforce their own visibility / authorisation. The
 * resolver does NOT inspect `metadata.guilde.visibility` — it trusts
 * the source to only return manifests the caller may see.
 */

import type { RoleHandle } from "../types.js"

/**
 * The raw manifest a source returns. Frontmatter is the parsed
 * (NOT yet schema-validated) object; body is the markdown body
 * verbatim. The resolver validates and merges; the source loads.
 */
export interface RoleManifestRaw {
  /** The role ref this manifest resolves (canonical / source-scoped). */
  readonly ref: string
  /** Parsed YAML frontmatter — shape is per AIP-47 (may include patches). */
  readonly frontmatter: unknown
  /** Markdown body — verbatim. */
  readonly body: string
  /**
   * The scheme that loaded this manifest. Useful for the resolution
   * chain debug surface ("`role:builtin → role:file → role:db`").
   */
  readonly scheme: string
}

/**
 * A role ref that has already been narrowed to a single source. The
 * resolver MAY normalise bare slugs to a scoped form ("`builtin/seo-
 * specialist`") when it walks the chain.
 */
export type RoleRef = string

export interface RoleSource {
  /**
   * The scheme this source serves. Conventional values:
   *   - `builtin` — TS registry shipped by a runtime
   *   - `file`    — file-system layout per AIP-47 §File location
   *   - `db`      — a database table (typically the runtime's role
   *                 table; see resources/aip-47/draft/ADAPTER.md)
   *   - `http`    — remote registry (optional in v1)
   *
   * Custom schemes are welcome — the resolver dispatches on the
   * `<scheme>://` prefix of a ref.
   */
  readonly scheme: string

  /**
   * Resolve a ref to a raw manifest. Returns `null` if the source
   * does not have this ref — the resolver will continue down the
   * chain. Throws on transport / corruption errors.
   */
  load(ref: RoleRef): Promise<RoleManifestRaw | null>

  /**
   * Enumerate ref ids this source can resolve. Optional — the
   * resolver does not require enumeration to work, but UI surfaces
   * (catalog browsing, "hire" flows) consume this.
   */
  list?(): Promise<readonly RoleRef[]>
}

/**
 * Helper: a `BuiltinRoleSource` ships a TS map of `slug → RoleHandle`
 * (already-resolved, already-validated). Loaded directly from a
 * runtime package like `@agentproto/role-catalog`.
 */
export interface BuiltinRoleEntry {
  readonly slug: string
  readonly handle: RoleHandle
  readonly body?: string
}
