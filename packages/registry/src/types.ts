/**
 * AIP-43 REGISTRY — public types.
 *
 * The registry is type-parametric over a doctype handle `H`. The
 * package itself doesn't know what STORAGE / SANDBOX / OPERATOR
 * handles look like — it just relies on a `keyBy(handle) => string`
 * selector and treats `handle.capabilities` (if present) as opaque
 * metadata for `lookup()` queries.
 */

export interface RegistryOptions<H> {
  /**
   * Informational label used in error messages and (when discovery
   * hooks are enabled) MCP tool names. Common values: `"storage"`,
   * `"sandbox"`, `"operator"`. Doesn't affect lookup semantics.
   */
  family: string
  /**
   * How to derive the registry key from a handle. Required when the
   * handle type doesn't expose a recognisable id field; the default
   * resolution (per AIP-43 § Identity) inspects `handle.id`,
   * `handle.provider`, `handle.slug` in priority order.
   */
  keyBy?: (handle: H) => string
}

export interface Registry<H> {
  /**
   * Add a handle. Throws `RegistryDuplicateError` if the resolved key
   * is already present — silent overwrite is unsafe (a second
   * `defineStorage({ provider: "s3" })` shadowing the first is the
   * exact bug class the registry exists to surface).
   */
  register(handle: H): void

  /** Returns true if the resolved key is registered. */
  has(id: string): boolean

  /** Number of handles currently registered. */
  count(): number

  /** Get the handle by id. Returns undefined if absent. */
  get(id: string): H | undefined

  /** Every handle currently registered, insertion-ordered. */
  list(): readonly H[]

  /** Every `[id, handle]` pair, insertion-ordered. */
  entries(): ReadonlyArray<readonly [string, H]>

  /**
   * Every handle matching `predicate`. Predicate runs in registration
   * order; ties are broken by insertion order.
   */
  lookup(predicate: (handle: H) => boolean): readonly H[]

  /**
   * Remove `id` from the registry. Returns true if a handle was
   * removed. Use sparingly — registries are intended to be
   * boot-time-stable.
   */
  unregister(id: string): boolean

  /**
   * Replace an existing handle. Throws `RegistryNotFoundError` if no
   * handle exists at `keyBy(handle)`. Use when a hot-reload picks up
   * a re-defined backend.
   */
  replace(handle: H): void
}

/**
 * Optional metadata that handles MAY expose on a `capabilities` field
 * (per AIP-43 § Capability metadata namespace). The registry does NOT
 * validate the shape — capabilities are opaque to the catalog. This
 * type is a documentation hint for hosts that want to converge on a
 * common namespace.
 */
export interface SuggestedCapabilities {
  /** Can the bytes be mounted into a sandbox? (storage) */
  bridgeable?: boolean
  /** How a sandbox sees the bytes when bridgeable. */
  transport?: "symlink" | "fuse" | "mcp" | "tunnel" | (string & {})
  /** Backend ids of the other family that compose cleanly. */
  pairsWith?: string[]
  /**
   * Can a remote host reach this backend? `false` for `local-ide` /
   * loopback `local-daemon` setups where the server can't reach the
   * user's machine without a tunnel.
   */
  serverReachable?: boolean
}

/** Thrown by `register(...)` when the key is already taken. */
export class RegistryDuplicateError extends Error {
  readonly code = "registry_duplicate" as const
  constructor(family: string, id: string) {
    super(
      `[registry/${family}] handle '${id}' is already registered. ` +
        `Call unregister('${id}') first if replacement is intentional, ` +
        `or replace(handle) to swap atomically.`,
    )
    this.name = "RegistryDuplicateError"
  }
}

/** Thrown by `replace(...)` when no handle exists at the resolved key. */
export class RegistryNotFoundError extends Error {
  readonly code = "registry_not_found" as const
  constructor(family: string, id: string) {
    super(
      `[registry/${family}] handle '${id}' is not registered; ` +
        `replace() requires an existing entry. Use register() for new handles.`,
    )
    this.name = "RegistryNotFoundError"
  }
}

/**
 * Thrown when `keyBy` fails to derive a key (returns empty string,
 * undefined, or throws). The registry can't store unkeyed handles.
 */
export class RegistryKeyError extends Error {
  readonly code = "registry_key_error" as const
  constructor(family: string, reason: string) {
    super(`[registry/${family}] ${reason}`)
    this.name = "RegistryKeyError"
  }
}
