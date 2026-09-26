/**
 * The stored pairing credential and where it lives.
 *
 * `PairCredential` carries what the Node CLI persists per pairing
 * (`~/.agentproto/pair-credentials.json`, `ClientPairing` in
 * `packages/cli/src/util/client-pairings.ts`) — the pinned daemon keys, the
 * rendezvous URL, the pair root, timestamps — so a reconnect is byte-for-byte
 * the one the CLI makes. Two differences, both client-local:
 *
 *   - `pairRoot` is normally a **non-extractable** WebCrypto HKDF `CryptoKey`
 *     (`importPairRootKey`): script can derive the epoch routing tokens with
 *     it but can't read the secret back out. IndexedDB stores it as-is
 *     (structured clone). A base64 string is accepted too (e.g. a credential
 *     imported from the CLI's file).
 *   - The CLI keeps one `name` that is both the user's label and the handshake
 *     `clientName`; here `name` is the daemon's display name and `clientName`
 *     the label this device announced to the daemon (what `pair ls` shows).
 *
 * No localStorage anywhere: `createIndexedDbCredentialStore` for browsers and
 * service workers, `createMemoryCredentialStore` for tests.
 */

export interface PairCredential {
  /** Store key: the daemon fingerprint (one credential per daemon, as the CLI
   *  keys its pairings). */
  id: string
  /** Daemon identity fingerprint (16 hex): the pin. */
  fingerprint: string
  /** Daemon display name: its tunnel `hello` label, else its host name, else
   *  the fingerprint. */
  name: string
  /** The label this device sent in the handshake (the daemon's `pair ls` name). */
  clientName: string
  /** Daemon static X25519 public key (base64 SPKI DER), pinned. */
  daemonX25519Pub: string
  /** Daemon static Ed25519 public key (base64 SPKI DER), pinned: verifies the
   *  daemon's transcript signature on every (re)connect. */
  daemonEd25519Pub: string
  /** Rendezvous endpoint to reconnect through. */
  rendezvousUrl: string
  /** Long-term shared secret the epoch routing tokens derive from: a
   *  non-extractable HKDF `CryptoKey`, or base64. */
  pairRoot: CryptoKey | string
  /** ISO-8601 when this pairing was made. */
  createdAt: string
  /** ISO-8601 of the most recent (re)connect. */
  lastSeen: string
}

export interface CredentialStore {
  get(id: string): Promise<PairCredential | undefined>
  /** Insert or replace (keyed by `id`). */
  put(credential: PairCredential): Promise<void>
  /** Returns whether something was removed. */
  delete(id: string): Promise<boolean>
  list(): Promise<PairCredential[]>
}

/** In-memory store (tests, or a page that must not persist). */
export function createMemoryCredentialStore(initial: PairCredential[] = []): CredentialStore {
  const byId = new Map(initial.map(c => [c.id, c]))
  return {
    async get(id) {
      return byId.get(id)
    },
    async put(credential) {
      byId.set(credential.id, credential)
    },
    async delete(id) {
      return byId.delete(id)
    },
    async list() {
      return [...byId.values()]
    },
  }
}

export interface IndexedDbCredentialStoreOptions {
  /** Database name. Default `agentproto-pair`. */
  dbName?: string
  /** Object store name. Default `credentials`. */
  storeName?: string
  /** The IndexedDB factory. Default `globalThis.indexedDB` (window or worker). */
  indexedDB?: IDBFactory
}

/**
 * IndexedDB-backed store. Works in a window and in a service worker (both
 * expose `indexedDB`); credentials are scoped to the origin like all IndexedDB
 * data. The `CryptoKey` pair root is stored by structured clone, so it stays
 * non-extractable at rest and after reload.
 */
export function createIndexedDbCredentialStore(
  opts: IndexedDbCredentialStoreOptions = {},
): CredentialStore {
  const dbName = opts.dbName ?? "agentproto-pair"
  const storeName = opts.storeName ?? "credentials"
  let dbPromise: Promise<IDBDatabase> | null = null

  const open = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise
    const factory = opts.indexedDB ?? globalThis.indexedDB
    if (!factory) return Promise.reject(new Error("IndexedDB is not available in this context"))
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(dbName, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(storeName)) {
          req.result.createObjectStore(storeName, { keyPath: "id" })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"))
    })
    dbPromise.catch(() => {
      dbPromise = null
    })
    return dbPromise
  }

  const run = async <T>(
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await open()
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode)
      const req = op(tx.objectStore(storeName))
      tx.oncomplete = () => resolve(req.result)
      tx.onerror = () => reject(tx.error ?? req.error ?? new Error("IndexedDB request failed"))
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"))
    })
  }

  return {
    async get(id) {
      return (await run<PairCredential | undefined>("readonly", s => s.get(id))) ?? undefined
    },
    async put(credential) {
      await run("readwrite", s => s.put(credential))
    },
    async delete(id) {
      const existing = await run<number>("readonly", s => s.count(id))
      if (existing === 0) return false
      await run("readwrite", s => s.delete(id))
      return true
    },
    async list() {
      return run<PairCredential[]>("readonly", s => s.getAll())
    },
  }
}
