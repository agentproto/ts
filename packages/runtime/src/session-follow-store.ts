/**
 * SessionFollowStore — persists `~/.agentproto/follows.json`.
 *
 * A "follow" lets one long-lived session (the FOLLOWER) be woken by the
 * lifecycle events of OTHER sessions matched by a selector — including root
 * sessions it did not spawn. The matching engine lives in `session-follow.ts`;
 * this file is only the record shape + persistence.
 *
 * Persistence model mirrors `sentinel-store.ts`: in-memory Map, loaded on
 * construct, debounced atomic write (per-process tmp file + rename, mode
 * 0600), synchronous flush at shutdown. A follow whose follower session no
 * longer exists is KEPT — the follower may be revived.
 */

import { resolve, dirname, join } from "node:path"
import { homedir } from "node:os"
import { readFileSync, mkdirSync, writeFileSync, chmodSync, renameSync, promises as fsp } from "node:fs"
import { ulid } from "./app-state.js"

// ── Types ─────────────────────────────────────────────────────────────

/** The event kinds a follow can subscribe to. */
export const FOLLOW_EVENTS = [
  "turn-end",
  "awaiting-input",
  "exited",
  "crashed",
  "pr-opened",
  "pr-merged",
] as const
export type FollowEvent = (typeof FOLLOW_EVENTS)[number]

export const DEFAULT_FOLLOW_BATCH_MS = 15_000
export const MAX_FOLLOW_BATCH_MS = 10 * 60_000

export interface FollowSelector {
  /** Explicit session ids to follow (always match, regardless of `rootOnly`). */
  sessionIds?: string[]
  /** Follow every session that exists at EVENT time (auto-covers sessions
   *  spawned after the follow was created). */
  all?: boolean
  /** Match sessions whose cwd is this path or below it. */
  cwdPrefix?: string
  /** Only sessions with no `parentSessionId`. Effective default: `true` when
   *  `all`, otherwise `false`. Stored resolved. */
  rootOnly?: boolean
}

export interface FollowExclude {
  sessionIds?: string[]
  labels?: string[]
}

export interface SessionFollow {
  /** `fol_<ulid>`, daemon-minted. */
  id: string
  /** Optional stable caller-chosen key: re-posting the same key updates the
   *  existing follow in place (UPSERT). */
  key?: string
  /** The session that gets woken. */
  follower: string
  /** ISO-8601 creation time. */
  createdAt: string
  selector: FollowSelector
  exclude?: FollowExclude
  /** Subscribed event kinds. Stored resolved (default: all of them). */
  events: FollowEvent[]
  /** Coalescing window per follower. Default 15000; 0 = next tick. */
  batchMs: number
  /** Drop turn-ends flagged `empty` (silent no-op turns). Default true. */
  skipEmptyTurns: boolean
  /** Ignore sessions descending from the follower. Default true. */
  excludeFollowerChildren: boolean
}

/** Fully-resolved input for {@link SessionFollowStore.upsert}. */
export interface SessionFollowInput {
  key?: string
  follower: string
  selector: FollowSelector
  exclude?: FollowExclude
  events?: readonly FollowEvent[]
  batchMs?: number
  skipEmptyTurns?: boolean
  excludeFollowerChildren?: boolean
}

export interface SessionFollowStore {
  get(id: string): SessionFollow | undefined
  /** Look up by id first, then by `key`. */
  find(idOrKey: string): SessionFollow | undefined
  list(filter?: { follower?: string }): SessionFollow[]
  /** UPSERT by `key` when given (keeps `id` + `createdAt`), else create. */
  upsert(input: SessionFollowInput): { follow: SessionFollow; created: boolean }
  /** Re-point a follow at another follower session (a revived follower). */
  setFollower(id: string, follower: string): SessionFollow | undefined
  /** Remove by id or key. */
  remove(idOrKey: string): SessionFollow | undefined
  /** Synchronous flush for shutdown paths. */
  flushSync(): void
}

// ── Constants ─────────────────────────────────────────────────────────

function agentprotoHome(): string {
  return process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto")
}

export const FOLLOWS_FILE_PATH = (): string => resolve(agentprotoHome(), "follows.json")

const PERSIST_DEBOUNCE_MS = 1_500

let tmpSeq = 0

export function mintFollowId(nowMs: number = Date.now()): string {
  return `fol_${ulid(nowMs)}`
}

/** Apply the documented defaults to a raw input. */
export function resolveFollowDefaults(input: SessionFollowInput): Omit<SessionFollow, "id" | "createdAt"> {
  const selector: FollowSelector = { ...input.selector }
  if (selector.sessionIds) selector.sessionIds = [...new Set(selector.sessionIds)]
  selector.rootOnly = selector.rootOnly ?? selector.all === true
  const exclude =
    input.exclude && ((input.exclude.sessionIds?.length ?? 0) > 0 || (input.exclude.labels?.length ?? 0) > 0)
      ? {
          ...(input.exclude.sessionIds?.length ? { sessionIds: [...new Set(input.exclude.sessionIds)] } : {}),
          ...(input.exclude.labels?.length ? { labels: [...new Set(input.exclude.labels)] } : {}),
        }
      : undefined
  return {
    ...(input.key ? { key: input.key } : {}),
    follower: input.follower,
    selector,
    ...(exclude ? { exclude } : {}),
    events: input.events && input.events.length > 0 ? [...new Set(input.events)] : [...FOLLOW_EVENTS],
    batchMs: input.batchMs ?? DEFAULT_FOLLOW_BATCH_MS,
    skipEmptyTurns: input.skipEmptyTurns ?? true,
    excludeFollowerChildren: input.excludeFollowerChildren ?? true,
  }
}

// ── Factory ───────────────────────────────────────────────────────────

export interface SessionFollowStoreOptions {
  /** Override persist path. Default ~/.agentproto/follows.json (or
   *  AGENTPROTO_HOME/follows.json). */
  filePath?: string
  /** Injectable clock for tests. */
  nowMs?: () => number
  /** Debounce interval for disk persistence. */
  debounceMs?: number
  /** Disable disk persistence (unit tests). Default true, unless `false`
   *  is passed; an explicit `filePath` implies persistence. */
  persist?: boolean
}

export function createSessionFollowStore(opts?: SessionFollowStoreOptions): SessionFollowStore {
  const filePath = opts?.filePath ?? FOLLOWS_FILE_PATH()
  const nowMs = opts?.nowMs ?? Date.now
  const debounceMs = opts?.debounceMs ?? PERSIST_DEBOUNCE_MS
  const persist = opts?.persist ?? true

  let persistTimer: ReturnType<typeof setTimeout> | null = null

  const load = (): Map<string, SessionFollow> => {
    const out = new Map<string, SessionFollow>()
    if (!persist) return out
    let raw: string
    try {
      raw = readFileSync(filePath, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[session-follow-store] read failed, starting empty: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      return out
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, SessionFollow>
      for (const [id, follow] of Object.entries(parsed)) {
        if (follow && typeof follow === "object" && typeof follow.follower === "string") out.set(id, follow)
      }
    } catch (err) {
      console.warn(
        `[session-follow-store] corrupt file, starting empty: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return out
  }

  const follows = load()

  const snapshot = (): Record<string, SessionFollow> => {
    const out: Record<string, SessionFollow> = {}
    for (const [id, follow] of follows.entries()) out[id] = follow
    return out
  }

  const schedulePersist = (): void => {
    if (!persist) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      void (async () => {
        try {
          const snap = snapshot()
          await fsp.mkdir(dirname(filePath), { recursive: true })
          const tmp = `${filePath}.tmp.${process.pid}.${++tmpSeq}`
          await fsp.writeFile(tmp, JSON.stringify(snap, null, 2) + "\n", { mode: 0o600 })
          await fsp.chmod(tmp, 0o600)
          await fsp.rename(tmp, filePath)
        } catch (err) {
          console.warn(
            `[session-follow-store] persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      })()
    }, debounceMs)
    // Never keep the process alive just for a pending debounced write.
    persistTimer.unref?.()
  }

  const flushSync = (): void => {
    if (!persist) return
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp.${process.pid}.${++tmpSeq}`
      writeFileSync(tmp, JSON.stringify(snapshot(), null, 2) + "\n", { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, filePath)
    } catch {
      // best-effort — never throw in the shutdown path
    }
  }

  const findByKey = (key: string): SessionFollow | undefined => {
    for (const f of follows.values()) if (f.key === key) return f
    return undefined
  }

  return {
    get: id => follows.get(id),
    find: idOrKey => follows.get(idOrKey) ?? findByKey(idOrKey),
    list(filter) {
      const all = Array.from(follows.values())
      return filter?.follower ? all.filter(f => f.follower === filter.follower) : all
    },
    upsert(input) {
      const resolved = resolveFollowDefaults(input)
      const existing = input.key ? findByKey(input.key) : undefined
      if (existing) {
        const next: SessionFollow = { id: existing.id, createdAt: existing.createdAt, ...resolved }
        follows.set(existing.id, next)
        schedulePersist()
        return { follow: next, created: false }
      }
      const now = nowMs()
      const follow: SessionFollow = { id: mintFollowId(now), createdAt: new Date(now).toISOString(), ...resolved }
      follows.set(follow.id, follow)
      schedulePersist()
      return { follow, created: true }
    },
    setFollower(id, follower) {
      const existing = follows.get(id)
      if (!existing) return undefined
      const next = { ...existing, follower }
      follows.set(id, next)
      schedulePersist()
      return next
    },
    remove(idOrKey) {
      const existing = follows.get(idOrKey) ?? findByKey(idOrKey)
      if (!existing) return undefined
      follows.delete(existing.id)
      schedulePersist()
      return existing
    },
    flushSync,
  }
}
