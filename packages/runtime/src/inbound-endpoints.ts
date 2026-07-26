/**
 * InboundEndpointStore — persists per-slug inbound provider endpoints.
 *
 * State is in-memory; endpoints persist to disk (debounced async write +
 * sync flush), mirroring the cursor-store pattern in inbound-watcher.ts and
 * the transmitter-binding store in transmitter-bindings.ts.
 *
 * Deduplication (`markSeen`) is intentionally in-memory only: a bounded FIFO
 * per slug (cap 500 ids) with a global cap (~5000). A daemon restart re-accepting
 * one redelivery is acceptable; an unbounded map is not.
 */

import { resolve, dirname } from "node:path"
import { homedir } from "node:os"
import { readFileSync, mkdirSync, writeFileSync, promises as fsp } from "node:fs"
import type { InboundProvider } from "./inbound-adapters.js"
import type { InboundRouteMode } from "./inbound-router.js"

// ── Types ─────────────────────────────────────────────────────────────

export interface InboundEndpoint {
  /** Path segment: POST /inbound/<slug>. */
  slug: string
  provider: InboundProvider
  /** Binding alias — MUST match what transmit_message wrote. */
  alias: string
  /** Force binding source; default = provider channel. */
  source?: string
  /** When set, signature auth is REQUIRED. */
  secret?: string
  mode: InboundRouteMode
  enabled: boolean
  createdTs: number
  lastSeenTs?: number
}

export interface InboundEndpointUpsert {
  slug: string
  provider: InboundProvider
  alias: string
  source?: string
  secret?: string
  mode?: InboundRouteMode
  enabled?: boolean
  createdTs?: number
  lastSeenTs?: number
}

export interface InboundEndpointStore {
  get(slug: string): InboundEndpoint | undefined
  upsert(e: InboundEndpointUpsert): InboundEndpoint
  remove(slug: string): boolean
  list(): InboundEndpoint[]
  /** true = first time we've seen this provider message id on this slug. */
  markSeen(slug: string, providerMessageId: string): boolean
  /** Synchronous flush for shutdown paths. */
  flushSync(): void
}

// ── Constants ─────────────────────────────────────────────────────────

export const ENDPOINTS_FILE_PATH = (): string =>
  resolve(homedir(), ".agentproto", "inbound-endpoints.json")

const PERSIST_DEBOUNCE_MS = 1_500

/** Per-slug cap for the in-memory seen-id FIFO. */
const SEEN_PER_SLUG_CAP = 500
/** Global cap across all slugs; keeps total memory bounded. */
const SEEN_GLOBAL_CAP = 5_000

// ── Factory ───────────────────────────────────────────────────────────

export interface InboundEndpointStoreOptions {
  /** Override persist path. Default ~/.agentproto/inbound-endpoints.json. */
  filePath?: string
  /** Injectable clock for tests. */
  nowMs?: () => number
  /** Debounce interval for disk persistence. */
  debounceMs?: number
  /** Disable disk persistence (unit tests). Default false. */
  persist?: boolean
}

export function createInboundEndpointStore(
  opts?: InboundEndpointStoreOptions,
): InboundEndpointStore {
  const filePath = opts?.filePath ?? ENDPOINTS_FILE_PATH()
  const nowMs = opts?.nowMs ?? Date.now
  const debounceMs = opts?.debounceMs ?? PERSIST_DEBOUNCE_MS
  const persist = opts?.persist ?? opts?.filePath !== undefined

  let persistTimer: ReturnType<typeof setTimeout> | null = null

  // ── Load-on-construct ────────────────────────────────────────────────

  const load = (): Map<string, InboundEndpoint> => {
    const out = new Map<string, InboundEndpoint>()
    let raw: string
    try {
      raw = readFileSync(filePath, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[inbound-endpoints] read failed, starting empty: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      return out
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, InboundEndpoint>
      for (const [key, endpoint] of Object.entries(parsed)) {
        out.set(key, endpoint)
      }
    } catch (err) {
      console.warn(
        `[inbound-endpoints] corrupt file, starting empty: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return out
  }

  const endpoints = load()

  // Bounded FIFO of provider message ids per slug. Not persisted — a restart
  // re-accepting one redelivery is acceptable (provider retry semantics).
  const seen = new Map<string, string[]>()
  let totalSeen = 0

  // ── Persistence (mirrors transmitter-bindings.ts) ───────────────────

  const snapshot = (): Record<string, InboundEndpoint> => {
    const out: Record<string, InboundEndpoint> = {}
    for (const [key, endpoint] of endpoints.entries()) out[key] = endpoint
    return out
  }

  const schedulePersist = (): void => {
    if (!persist) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      void (async () => {
        try {
          const snap = snapshot()
          await fsp.mkdir(dirname(filePath), { recursive: true })
          // mode 0600 -- each endpoint's webhook secret is stored in
          // plaintext here (same tradeoff as transmitter-bindings.json),
          // matching every other credential-bearing file in this runtime
          // (telegram-bot-creds, pairing-registry, user-presets, ...).
          await fsp.writeFile(filePath, JSON.stringify(snap, null, 2) + "\n", { mode: 0o600 })
        } catch (err) {
          console.warn(
            `[inbound-endpoints] persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      })()
    }, debounceMs)
  }

  const flushSync = (): void => {
    if (!persist) return
    try {
      const snap = snapshot()
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, JSON.stringify(snap, null, 2) + "\n", { mode: 0o600 })
    } catch {
      // best-effort — never throw in shutdown path
    }
  }

  // ── Public interface ────────────────────────────────────────────────

  return {
    get(slug: string): InboundEndpoint | undefined {
      return endpoints.get(slug)
    },

    upsert(e: InboundEndpointUpsert): InboundEndpoint {
      const createdTs = e.createdTs ?? nowMs()
      const endpoint: InboundEndpoint = {
        slug: e.slug,
        provider: e.provider,
        alias: e.alias,
        source: e.source,
        secret: e.secret,
        mode: e.mode ?? "route-or-spawn",
        enabled: e.enabled ?? true,
        createdTs,
        lastSeenTs: e.lastSeenTs,
      }
      endpoints.set(e.slug, endpoint)
      schedulePersist()
      return endpoint
    },

    remove(slug: string): boolean {
      const existed = endpoints.delete(slug)
      if (existed) {
        seen.delete(slug)
        schedulePersist()
      }
      return existed
    },

    list(): InboundEndpoint[] {
      return Array.from(endpoints.values())
    },

    markSeen(slug: string, providerMessageId: string): boolean {
      const bucket = seen.get(slug) ?? []
      if (bucket.includes(providerMessageId)) return false

      bucket.push(providerMessageId)
      if (bucket.length > SEEN_PER_SLUG_CAP) {
        bucket.shift()
        totalSeen--
      }
      seen.set(slug, bucket)
      totalSeen++

      // Global cap: if we exceed it, prune the oldest bucket aggressively.
      if (totalSeen > SEEN_GLOBAL_CAP) {
        for (const [otherSlug, otherBucket] of seen) {
          if (otherBucket.length > 0) {
            otherBucket.shift()
            totalSeen--
          }
          if (totalSeen <= SEEN_GLOBAL_CAP) break
        }
      }

      return true
    },

    flushSync,
  }
}
