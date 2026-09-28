/**
 * Persisted registry of the GitHub repo hooks the `webhook` sentinel provider
 * owns — one record per repo, shared (refcounted) by every sentinel watching
 * that repo.
 *
 * This lives OUTSIDE `SentinelHandle`/`sentinels.json` on purpose: the HMAC
 * secret must not ride a handle (handles are echoed around the runtime), and
 * `resolveSentinelProvider` builds a fresh provider per call, so the shared
 * refcount can't live in provider memory. Hence a module-level singleton
 * store per file path, file mode 0600, secret never logged or returned by any
 * tool.
 *
 * Refcount = the `holders` set of opaque per-sentinel ids (the provider mints
 * one at `create`). A set rather than a counter makes `cancel` idempotent — the
 * runtime cancels on expiry and `sentinel_unwatch` cancels again.
 */

import { resolve, dirname, join } from "node:path"
import { homedir } from "node:os"
import { readFileSync, mkdirSync, writeFileSync, chmodSync, renameSync } from "node:fs"

export interface WebhookHookRecord {
  /** Random route key — the `<hookKey>` in `/inbound/sentinel-<hookKey>`. */
  key: string
  /** `owner/repo`. */
  repo: string
  /** GitHub hook id. */
  hookId: number
  /** HMAC secret GitHub signs deliveries with. Never logged. */
  secret: string
  /** Public origin the GitHub hook currently points at. */
  origin: string
  /** Sentinel holder ids sharing this hook. */
  holders: string[]
  createdAt: string
}

export interface WebhookHookStore {
  getByRepo(repo: string): WebhookHookRecord | undefined
  getByKey(key: string): WebhookHookRecord | undefined
  put(record: WebhookHookRecord): void
  remove(repo: string): void
  list(): WebhookHookRecord[]
  /** Serialize async read-modify-write sequences per repo (gh calls sit in
   *  the middle, so a bare sync map isn't enough). */
  withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T>
}

export interface WebhookHookStoreOptions {
  filePath?: string
  /** Default: true when `filePath` is given or defaulted, false for
   *  `persist:false` (tests). */
  persist?: boolean
}

function agentprotoHome(): string {
  return process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto")
}

export const WEBHOOK_HOOKS_FILE_PATH = (): string => resolve(agentprotoHome(), "sentinel-webhooks.json")

let tmpSeq = 0

export function createWebhookHookStore(opts: WebhookHookStoreOptions = {}): WebhookHookStore {
  const filePath = opts.filePath ?? WEBHOOK_HOOKS_FILE_PATH()
  const persist = opts.persist ?? true
  const records = new Map<string, WebhookHookRecord>()
  const locks = new Map<string, Promise<unknown>>()

  if (persist) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, WebhookHookRecord>
      for (const [repo, rec] of Object.entries(parsed)) {
        if (rec && typeof rec.key === "string" && typeof rec.secret === "string" && typeof rec.hookId === "number") {
          records.set(repo, { ...rec, holders: Array.isArray(rec.holders) ? rec.holders : [] })
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[sentinel-webhooks] unreadable hook store, starting empty: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const flush = (): void => {
    if (!persist) return
    const snapshot: Record<string, WebhookHookRecord> = {}
    for (const [repo, rec] of records) snapshot[repo] = rec
    mkdirSync(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp.${process.pid}.${++tmpSeq}`
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, filePath)
  }

  return {
    getByRepo: repo => records.get(repo),
    getByKey(key) {
      for (const rec of records.values()) if (rec.key === key) return rec
      return undefined
    },
    put(record) {
      records.set(record.repo, record)
      flush()
    },
    remove(repo) {
      if (records.delete(repo)) flush()
    },
    list: () => [...records.values()],
    withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
      const prev = locks.get(repo) ?? Promise.resolve()
      const run = prev.then(fn, fn)
      const tail = run.catch(() => undefined)
      locks.set(repo, tail)
      void tail.then(() => {
        if (locks.get(repo) === tail) locks.delete(repo)
      })
      return run
    },
  }
}

const shared = new Map<string, WebhookHookStore>()

/** Process-wide store for a file path — fresh providers built per
 *  `resolveSentinelProvider` call all see the same refcount state and lock. */
export function getSharedWebhookHookStore(filePath: string = WEBHOOK_HOOKS_FILE_PATH()): WebhookHookStore {
  let store = shared.get(filePath)
  if (!store) {
    store = createWebhookHookStore({ filePath })
    shared.set(filePath, store)
  }
  return store
}
