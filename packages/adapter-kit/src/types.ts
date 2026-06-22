/**
 * Core generic types for the adapter kit.
 *
 * Everything here is family-agnostic. Each adapter family (agent-CLI,
 * browser, tunnel) parameterises the kit with its own `TInfo` descriptor
 * and its own `THandle` (which extends {@link AdapterHandle}). The kit owns
 * the catalog/status/entry vocabulary; the families own the concrete data.
 *
 * Security contract (Appendix B of the design): `TInfo` and
 * {@link AdapterEntry} MUST NOT carry any value drawn from the creds store.
 * The kit does not deep-scan for this at runtime — family `toInfo` callbacks
 * are responsible for upholding it.
 */

/**
 * Three-level adapter status.
 *
 *   "supported" — catalog knows it; package not importable (not installed)
 *   "available" — package resolves; requiresSetup but no ledger/creds yet
 *   "ready"     — package resolves + setup complete (or no setup needed)
 */
export type AdapterStatus = "supported" | "available" | "ready"

/** Static, per-family catalog entry. Pure data — no live state. */
export interface AdapterCatalogEntry {
  /** Lower-kebab slug, e.g. "claude-code", "ngrok". */
  slug: string
  /** Display name. */
  name: string
  /** One-liner safe for MCP tool hints. */
  description: string
  /** npm package that provides the handle. */
  packageName: string
  /** Short tag for picker UX (e.g. "openai · ACP"). */
  hint?: string
}

/** A family's static catalog. */
export type AdapterCatalog = readonly AdapterCatalogEntry[]

/**
 * Runtime entry: catalog fields + live status + the family descriptor.
 *
 * `info` is absent when `status === "supported"` (the handle could not be
 * resolved, so there is nothing to describe). `version` is the literal
 * string `"not installed"` in that case.
 */
export interface AdapterEntry<TInfo> {
  // — from catalog —
  slug: string
  name: string
  description: string
  packageName: string
  hint?: string
  // — from runtime resolution —
  status: AdapterStatus
  version: string
  info?: TInfo
}

/**
 * Base interface every adapter handle satisfies. Families extend this with
 * their own fields (commands, models, defaultPort, ensure(), start(), …).
 *
 * The kit never calls `check()` during listing — status is derived purely
 * from resolvability + ledger/creds existence (see {@link AdapterStatus}).
 * `check()` is reserved for on-demand health probes.
 */
export interface AdapterHandle {
  readonly slug: string
  readonly name: string
  readonly version: string
  readonly description: string
  /** True when the adapter requires a creds/setup pass before use. */
  readonly requiresSetup: boolean
  /**
   * Probe whether the adapter is locally operational (binary present,
   * API reachable, etc.) without requiring creds to be present.
   * Returns true = reachable, false = not available. Always async —
   * I/O is expected (dynamic import, fs.access, HTTP probe).
   *
   * NOT invoked by the kit's lister; reserved for health-probe tools.
   */
  check(): Promise<boolean>
}

/** Setup-ledger record. Timestamps + step ids only — never cred values. */
export interface SetupLedgerRecord {
  slug: string
  /** ISO-8601 of when setup completed. */
  completedAt: string
  steps: { id: string; completedAt: string }[]
}

/** Resolve a slug to a handle, or `null` when not installed/importable. */
export type AdapterResolver<THandle> = (slug: string) => Promise<THandle | null>

/** Produce the full runtime entry list for a family. */
export type AdapterLister<TInfo> = () => Promise<AdapterEntry<TInfo>[]>
