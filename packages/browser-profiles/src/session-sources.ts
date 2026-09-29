/**
 * The `SessionSource` registry: how a host supplies cookies that live somewhere
 * this package knows nothing about (a managed central store, a vault, a device
 * bridge). The descriptor carries only a `kind`, a `sessionRef` and `domains`;
 * the registered source materialises the cookies at resolve time.
 *
 * Replaces the hard-wired `guilde` inject: the studio registers a `"guilde"`
 * source, the open package never mentions it.
 */

import type { SessionCookie } from "./cookie.js"
import { isBuiltinStrategyKind, type SessionDescriptor, type SessionIdentity } from "./descriptor.js"
import {
  SessionSourceDuplicateError,
  SessionSourceReservedError,
  SessionSourceUnknownError,
} from "./errors.js"
import type { SessionStorePort } from "./store.js"

export interface SessionSourceRef {
  sessionRef: string
  /** Only these domains' cookies may be returned, never the whole jar. */
  domains: readonly string[]
}

export interface SessionSource {
  /** The `inject.from` / `strategy.kind` this source answers to. Not a built-in kind. */
  readonly kind: string
  materialize(ref: SessionSourceRef): Promise<SessionCookie[]>
}

export interface SessionSourceRegistry {
  /** Register a source. Throws on a duplicate kind or a built-in kind. */
  register(source: SessionSource): void
  list(): readonly SessionSource[]
  has(kind: string): boolean
  /** The source for `kind`, or a typed {@link SessionSourceUnknownError}. */
  resolve(kind: string): SessionSource
  materialize(kind: string, ref: SessionSourceRef): Promise<SessionCookie[]>
}

export function createSessionSourceRegistry(initial: readonly SessionSource[] = []): SessionSourceRegistry {
  const sources = new Map<string, SessionSource>()
  const registry: SessionSourceRegistry = {
    register(source) {
      if (isBuiltinStrategyKind(source.kind) || source.kind === "chrome-profile" || source.kind === "file" || source.kind === "camofox-native") {
        throw new SessionSourceReservedError(source.kind)
      }
      if (sources.has(source.kind)) throw new SessionSourceDuplicateError(source.kind)
      sources.set(source.kind, source)
    },
    list: () => [...sources.values()],
    has: kind => sources.has(kind),
    resolve(kind) {
      const found = sources.get(kind)
      if (!found) throw new SessionSourceUnknownError(kind, [...sources.keys()])
      return found
    },
    materialize: (kind, ref) => registry.resolve(kind).materialize(ref),
  }
  for (const s of initial) registry.register(s)
  return registry
}

/** Catalog row of a centrally managed session. Carries NO cookies. */
export interface SessionSourceMeta {
  ref: string
  domains: string[]
  identity?: SessionIdentity
  url?: string
}

export interface SessionSourceCatalog {
  list(): Promise<SessionSourceMeta[]>
  get(ref: string): Promise<SessionSourceMeta | null>
}

function metaToDescriptor(kind: string, m: SessionSourceMeta): SessionDescriptor {
  return {
    id: m.ref,
    backend: "camofox",
    ...(m.identity ? { identity: m.identity } : {}),
    inject: { from: kind, sessionRef: m.ref, domains: m.domains },
    ...(m.url ? { url: m.url } : {}),
  }
}

/**
 * Read-only descriptor store over a catalog of managed sessions, resolving them
 * into `from: <kind>` descriptors. `save` and `remove` throw: sessions are
 * captured elsewhere, so the contract stays loud.
 */
export function catalogSessionStore(kind: string, catalog: SessionSourceCatalog): SessionStorePort {
  return {
    async save() {
      throw new Error(`the "${kind}" catalog store is read-only; capture sessions in the managing system`)
    },
    async load(id) {
      const m = await catalog.get(id)
      return m ? metaToDescriptor(kind, m) : null
    },
    async list() {
      return (await catalog.list()).map(m => metaToDescriptor(kind, m))
    },
    async remove() {
      throw new Error(`the "${kind}" catalog store is read-only; manage sessions in the managing system`)
    },
  }
}
