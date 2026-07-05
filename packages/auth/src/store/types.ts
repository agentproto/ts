/**
 * CredentialStore — pluggable backend for persisting AIP-50 credentials.
 *
 * Flow engines read/write through this interface instead of hard-coding a
 * specific backend. `StoreRef.path` is the storage slot key — the macOS
 * Keychain "service" name today, a Map key for `MemoryStore`, a JSON object
 * key for `FileStore`.
 */

/** A persisted credential value plus the bookkeeping needed to use it again
 *  without re-running the auth flow. */
export interface StoredCredential {
  /** The raw credential string — a PAT, an identity assertion JWT, … */
  value: string
  /** What `value` is. Mirrors `FlowResult.tokenKind`. */
  kind: "pat" | "assertion" | "oat"
  /** ISO 8601 expiry, when the credential has one. */
  expiresAt?: string
  /** Backend- or flow-specific extras that don't fit `value`/`kind`/`expiresAt`. */
  metadata?: Record<string, unknown>
}

/** Where a credential lives, independent of backend. */
export interface StoreRef {
  /** Storage slot key — a Keychain service name, a file-store map key, … */
  path: string
  /** Sub-slot within `path` (a Keychain account, …). Defaults to `path`
   *  itself when a backend needs *some* account and none was resolved. */
  account?: string
}

/** A pluggable credential backend. Flow engines depend on this interface,
 *  never on a concrete backend — see `KeychainStore`, `MemoryStore`, `FileStore`. */
export interface CredentialStore {
  /** Read the credential at `ref`, or `undefined` if none is stored. */
  read(ref: StoreRef): Promise<StoredCredential | undefined>
  /** Write (or overwrite) the credential at `ref`. */
  write(ref: StoreRef, cred: StoredCredential): Promise<void>
  /** Remove the credential at `ref`, if the backend supports deletion. */
  delete?(ref: StoreRef): Promise<void>
}
