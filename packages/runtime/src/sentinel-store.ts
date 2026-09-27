/**
 * SentinelStore — persists `~/.agentproto/sentinels.json` (AIP-60 §2).
 *
 * State is in-memory; sentinels persist to disk (debounced async write +
 * sync flush at shutdown), mirroring `inbound-endpoints.ts`'s
 * `InboundEndpointStore`. Unlike that store's `markSeen` (deliberately
 * in-memory only), dedup here is PERSISTED per sentinel, bounded to the last
 * 1000 event ids (design §2/§9) — a sentinel's dedup window must survive a
 * daemon restart, since the whole point of a sentinel is to keep watching
 * across restarts.
 *
 * Writes are atomic (write to a per-process tmp file, then rename), same
 * idiom as `sandbox-ledger.ts` — a crash mid-write must never leave a
 * corrupt `sentinels.json` behind.
 */

import { resolve, dirname, join } from "node:path"
import { homedir } from "node:os"
import { readFileSync, mkdirSync, writeFileSync, chmodSync, renameSync, promises as fsp } from "node:fs"
import { ulid } from "./app-state.js"
import type { SentinelHandle, SentinelSpec } from "./sentinel-providers/types.js"

// ── Types ─────────────────────────────────────────────────────────────

export type SentinelStatus = "active" | "paused" | "expired" | "orphaned" | "error"

export interface Sentinel {
  /** `sen_<ulid>`, daemon-minted. */
  id: string
  spec: SentinelSpec
  /** Resolved provider slug (never undefined once created, even when
   *  `spec.provider` was left for auto-select). */
  provider: string
  /** Opaque provider state (remote id, cursor, hook id, …). */
  handle: SentinelHandle
  status: SentinelStatus
  createdTs: number
  lastEventTs?: number
  eventCount: number
  lastError?: string
  /** Last `SEEN_CAP` event ids delivered/skipped for this sentinel — the
   *  dedup window (design §2: "last 1000 event ids, dedup across providers/
   *  restarts"). */
  seen: string[]
}

export interface SentinelCreateInput {
  spec: SentinelSpec
  provider: string
  handle: SentinelHandle
  status?: SentinelStatus
}

export type SentinelUpdatePatch = Partial<
  Pick<Sentinel, "spec" | "provider" | "handle" | "status" | "lastEventTs" | "eventCount" | "lastError">
>

export interface SentinelStore {
  get(id: string): Sentinel | undefined
  list(): Sentinel[]
  create(input: SentinelCreateInput): Sentinel
  update(id: string, patch: SentinelUpdatePatch): Sentinel | undefined
  remove(id: string): boolean
  /** true = first time this event id has been seen for this sentinel
   *  (persisted dedup, bounded). Returns true (treat-as-unseen) for an
   *  unknown sentinel id — never blocks a caller who already validated the
   *  sentinel exists moments earlier. */
  markSeen(id: string, eventId: string): boolean
  /** Synchronous flush for shutdown paths. */
  flushSync(): void
}

// ── Constants ─────────────────────────────────────────────────────────

/** Respects the daemon's configured home dir override, same expression as
 *  `transcript-export.ts`'s `mastracodeInprocessDbPath` / the provider-kit
 *  `resolveHome` helper. */
function agentprotoHome(): string {
  return process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto")
}

export const SENTINELS_FILE_PATH = (): string => resolve(agentprotoHome(), "sentinels.json")

const PERSIST_DEBOUNCE_MS = 1_500

/** Per-sentinel cap for the persisted dedup window (design §2). */
const SEEN_CAP = 1_000

let tmpSeq = 0

// ── Factory ───────────────────────────────────────────────────────────

export interface SentinelStoreOptions {
  /** Override persist path. Default ~/.agentproto/sentinels.json (or
   *  AGENTPROTO_HOME/sentinels.json). */
  filePath?: string
  /** Injectable clock for tests. */
  nowMs?: () => number
  /** Debounce interval for disk persistence. */
  debounceMs?: number
  /** Disable disk persistence (unit tests). Default false, unless filePath
   *  is set (mirrors InboundEndpointStore's convention). */
  persist?: boolean
}

export function createSentinelStore(opts?: SentinelStoreOptions): SentinelStore {
  const filePath = opts?.filePath ?? SENTINELS_FILE_PATH()
  const nowMs = opts?.nowMs ?? Date.now
  const debounceMs = opts?.debounceMs ?? PERSIST_DEBOUNCE_MS
  const persist = opts?.persist ?? opts?.filePath !== undefined

  let persistTimer: ReturnType<typeof setTimeout> | null = null

  // ── Load-on-construct ────────────────────────────────────────────────

  const load = (): Map<string, Sentinel> => {
    const out = new Map<string, Sentinel>()
    if (!persist) return out
    let raw: string
    try {
      raw = readFileSync(filePath, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[sentinel-store] read failed, starting empty: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      return out
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, Sentinel>
      for (const [id, sentinel] of Object.entries(parsed)) out.set(id, sentinel)
    } catch (err) {
      console.warn(
        `[sentinel-store] corrupt file, starting empty: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return out
  }

  const sentinels = load()

  // ── Persistence (atomic tmp+rename, mirrors sandbox-ledger.ts) ───────

  const snapshot = (): Record<string, Sentinel> => {
    const out: Record<string, Sentinel> = {}
    for (const [id, sentinel] of sentinels.entries()) out[id] = sentinel
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
          const tmp = `${filePath}.tmp.${process.pid}.${++tmpSeq}`
          // mode 0600 -- a sentinel's handle can carry a provider secret
          // (e.g. a webhook hook id / cursor token), same tradeoff as every
          // other credential-adjacent store in this runtime.
          await fsp.writeFile(tmp, JSON.stringify(snap, null, 2) + "\n", { mode: 0o600 })
          await fsp.chmod(tmp, 0o600)
          await fsp.rename(tmp, filePath)
        } catch (err) {
          console.warn(
            `[sentinel-store] persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      })()
    }, debounceMs)
  }

  const flushSync = (): void => {
    if (!persist) return
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    try {
      const snap = snapshot()
      mkdirSync(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp.${process.pid}.${++tmpSeq}`
      writeFileSync(tmp, JSON.stringify(snap, null, 2) + "\n", { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, filePath)
    } catch {
      // best-effort — never throw in shutdown path
    }
  }

  // ── Public interface ────────────────────────────────────────────────

  return {
    get(id: string): Sentinel | undefined {
      return sentinels.get(id)
    },

    list(): Sentinel[] {
      return Array.from(sentinels.values())
    },

    create(input: SentinelCreateInput): Sentinel {
      const id = `sen_${ulid(nowMs())}`
      const sentinel: Sentinel = {
        id,
        spec: input.spec,
        provider: input.provider,
        handle: input.handle,
        status: input.status ?? "active",
        createdTs: nowMs(),
        eventCount: 0,
        seen: [],
      }
      sentinels.set(id, sentinel)
      schedulePersist()
      return sentinel
    },

    update(id: string, patch: SentinelUpdatePatch): Sentinel | undefined {
      const existing = sentinels.get(id)
      if (!existing) return undefined
      const next: Sentinel = { ...existing, ...patch }
      sentinels.set(id, next)
      schedulePersist()
      return next
    },

    remove(id: string): boolean {
      const existed = sentinels.delete(id)
      if (existed) schedulePersist()
      return existed
    },

    markSeen(id: string, eventId: string): boolean {
      const sentinel = sentinels.get(id)
      if (!sentinel) return true
      if (sentinel.seen.includes(eventId)) return false
      const nextSeen = [...sentinel.seen, eventId]
      if (nextSeen.length > SEEN_CAP) nextSeen.splice(0, nextSeen.length - SEEN_CAP)
      sentinels.set(id, { ...sentinel, seen: nextSeen })
      schedulePersist()
      return true
    },

    flushSync,
  }
}
