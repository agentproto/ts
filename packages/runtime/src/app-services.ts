/**
 * Service-owner launcher (Pygmalion AIP-standardization, Phase 1b item 2).
 *
 * An app manifest MAY declare a `services:` block of long-running processes
 * the app needs alongside its agents/workflows:
 *
 *   services:
 *     - name: web          # kebab slug, unique per app
 *       entry: node server.js   # the shell command to run
 *       port: 4321          # optional 1..65535 bookkeeping/health touchpoint
 *
 * One managed process per entry (see `app-service-process.ts` — a
 * deterministic, non-PTY child spawned detached and adopted into the
 * `sessions` REGISTRY, no LLM adapter involved) with its ownership
 * bookkeeping (label, origin, store record) here. The runner restarts the
 * child with backoff on an unexpected exit, capped; there is deliberately
 * NO scheduler here — no cron, no k8s, no queue.
 *
 * Ownership is persisted (appId + name + entry + the live process's
 * `sessionId` + its process-group-leader `pid`, in a JSON store next to the
 * installed-app registry) so `app_uninstall` can kill the recorded process
 * group and its registry row — otherwise a reinstall spawns a second owner
 * for a service still running from the old install
 * ("double-cerveau à la réinstall").
 *
 * Scope note: this module is the whole SERVICE-LAUNCHER behaviour, lifted out
 * of app-tools.ts so it is unit-testable without an MCP server or a real
 * spawn. `services:` validation itself now delegates to app's
 * `parseServiceList` — the single validator for the manifest `services:`
 * array, shared with `defineApp`/`loadAppHandle`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parseServiceList, type AppService } from "@agentproto/app"

import {
  APP_SERVICE_PUBLIC_URL_ENV,
  exposureEnv,
  isExposedService,
  type AppServiceExposer,
  type AppServiceExposure,
} from "./app-service-expose.js"

export type { AppService }

/** The manifest's `services:` list. */
export type AppServices = readonly AppService[]

/** The only key set the frozen semantics allow — a malformed block fails the
 *  install rather than silently launching a partial service set. */
export interface AppServiceValidation {
  services: AppService[]
  errors: string[]
}

/**
 * Validate a raw APP.md `services` frontmatter value — delegates to
 * app's `parseServiceList`, the single validator shared with
 * `defineApp`/`loadAppHandle`. `undefined`/`null` (no block) yields
 * `{ services: [], errors: [] }` — the launcher's no-op case, so an app
 * WITHOUT `services` is byte-for-byte unaffected. Any other malformed value
 * returns an `errors` entry and the caller refuses the install.
 */
export function parseAppServices(raw: unknown): AppServiceValidation {
  const { services, errors } = parseServiceList(raw)
  return { services: [...services], errors: [...errors] }
}

/** One service owner: the persisted ownership record — `appId` + the service
 *  `name`/`entry` + the registry row id and process-group-leader `pid` of the
 *  currently-live attempt, so uninstall can kill both. */
export interface AppServiceOwner {
  appId: string
  name: string
  entry: string
  /** Registry row id of the live attempt's process (`app_uninstall` kills
   *  the row + the process group). Updated on every respawn. */
  sessionId: string
  /** Process-group-leader pid of the live attempt (`app_uninstall` signals
   *  `-pid`), when the spawn surfaced one. Updated on every respawn. */
  pid?: number
  /** `/proc/<pid>/stat` start ticks of the recorded pid, captured at spawn
   *  time — the identity token a later boot reconcile verifies BEFORE
   *  signalling the recorded pid (a recycled pid has different ticks; see
   *  `assessRecordedServicePid`). Never signal a bare recorded pid without
   *  this check. */
  startTicks?: number
  /** Mirrors the declared `port` for bookkeeping. */
  port?: number
  /** The `AGENTPROTO_PUBLIC_URL` origin the live process was spawned with
   *  (AIP-53 Exposure rule 3). Unset: spawned without one. A kept owner
   *  whose origin is no longer the current one is respawned. */
  publicUrl?: string
  startedAt: string
}

/** The descriptor label a service owner is spawned under. */
export function serviceOwnerLabel(appId: string, name: string): string {
  return `app:${appId}:service:${name}`
}

/**
 * The owner record's persisted `entry` — a display string regardless of
 * whether the manifest used the legacy `entry` shell line or the structured
 * `{ command, args }` form (joined argv, no shell interpretation shown).
 * Uninstall bookkeeping keys off this only for humans; the real kill path
 * signals the recorded pid's process group (see `app-service-process.ts`).
 */
export function serviceDisplayEntry(service: AppService): string {
  if (service.command !== undefined) {
    return [service.command, ...(service.args ?? [])].join(" ")
  }
  return service.entry ?? ""
}

/**
 * SIGTERM a recorded pid, swallowing the two benign failures: `ESRCH` (the
 * process already exited) and `EPERM` (not ours to signal). Never throws — a
 * cleanup path must not fail on a stale pid.
 *
 * @deprecated Signals a bare pid with no identity check and not its process
 * group. Service cleanup now goes through `killServiceProcess` /
 * `assessRecordedServicePid` (see `app-service-process.ts`). Kept only for
 * backward compatibility; it will be removed in a future major.
 */
export function killServicePid(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return
  try {
    process.kill(pid, signal)
  } catch {
    // ESRCH (gone) / EPERM (not ours) — best-effort cleanup.
  }
}

// ── persistence ────────────────────────────────────────────────────────────

interface AppServiceStoreState {
  version: 1
  owners: AppServiceOwner[]
}

/** Persisted service-owner registry — mirrors `app-registry.ts`'s pattern
 *  (in-memory store, write-tmp + rename on every mutation). */
export interface AppServiceStore {
  list(): AppServiceOwner[]
  listForApp(appId: string): AppServiceOwner[]
  /** Insert or, keyed by `appId` + `name`, replace a service owner. */
  upsert(owner: AppServiceOwner): AppServiceOwner
  /** Remove one service owner by `appId` + `name`. Returns it, or undefined. */
  remove(appId: string, name: string): AppServiceOwner | undefined
  /** Remove every owner of an app. Returns how many were removed. */
  removeForApp(appId: string): number
}

const DEFAULT_SERVICE_STORE_PATH = (): string => join(homedir(), ".agentproto", "app-services.json")

function loadServiceState(persistPath: string): AppServiceStoreState {
  const empty: AppServiceStoreState = { version: 1, owners: [] }
  if (!existsSync(persistPath)) return empty
  try {
    const parsed = JSON.parse(readFileSync(persistPath, "utf8")) as Partial<AppServiceStoreState>
    return { version: 1, owners: Array.isArray(parsed.owners) ? parsed.owners : [] }
  } catch {
    return empty
  }
}

function saveServiceState(state: AppServiceStoreState, persistPath: string): void {
  try {
    mkdirSync(dirname(persistPath), { recursive: true })
    const tmp = `${persistPath}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8")
    renameSync(tmp, persistPath)
  } catch {
    // Best-effort — a write failure must not crash the daemon.
  }
}

/**
 * Memo of persisting stores per resolved path (audit F-6): each
 * `registerAppTools` call and the daemon boot pass each build a store for the
 * SAME persist file; without the memo, instance A's `upsert` rewrites the
 * whole file from ITS in-memory snapshot and silently erases instance B's
 * later write. One path ⇒ one shared state. Stores created with an explicit
 * `persist: false` NEVER join the memo (tests rely on isolated instances).
 */
const persistedServiceStores = new Map<string, AppServiceStore>()

export function createAppServiceStore(opts?: {
  persistPath?: string
  persist?: boolean
}): AppServiceStore {
  const persistPath = opts?.persistPath ?? DEFAULT_SERVICE_STORE_PATH()
  const shouldPersist = opts?.persist ?? opts?.persistPath !== undefined
  if (shouldPersist) {
    const memo = persistedServiceStores.get(persistPath)
    if (memo !== undefined) return memo
  }
  const state = shouldPersist ? loadServiceState(persistPath) : { version: 1 as const, owners: [] as AppServiceOwner[] }
  const persist = (): void => {
    if (shouldPersist) saveServiceState(state, persistPath)
  }
  const store: AppServiceStore = {
    list() {
      return [...state.owners]
    },
    listForApp(appId) {
      return state.owners.filter(o => o.appId === appId)
    },
    upsert(owner) {
      const idx = state.owners.findIndex(o => o.appId === owner.appId && o.name === owner.name)
      if (idx === -1) state.owners.push(owner)
      else state.owners[idx] = owner
      persist()
      return owner
    },
    remove(appId, name) {
      const idx = state.owners.findIndex(o => o.appId === appId && o.name === name)
      if (idx === -1) return undefined
      const [removed] = state.owners.splice(idx, 1)
      persist()
      return removed
    },
    removeForApp(appId) {
      const before = state.owners.length
      state.owners = state.owners.filter(o => o.appId !== appId)
      const removed = before - state.owners.length
      if (removed > 0) persist()
      return removed
    },
  }
  if (shouldPersist) persistedServiceStores.set(persistPath, store)
  return store
}

// ── orchestration ───────────────────────────────────────────────────────────

/**
 * Per-app transition locks (audit F-5): every ensure/reensure/remove for an
 * appId is serialized through this in-flight promise chain, so a concurrent
 * `app_install` racing the boot reconcile (or two MCP clients) can never
 * read-modify-write the same owner set at once — no double-spawns, no
 * clobbered records. Module-level: it spans every store instance and every
 * handle creation inside one daemon process.
 */
const appServiceLocks = new Map<string, Promise<unknown>>()

export async function withAppServiceLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
  const prev = appServiceLocks.get(appId) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  appServiceLocks.set(appId, tail)
  // Drop the entry once this call is the settled tail — otherwise the map
  // would keep one promise chain per app id for the daemon lifetime.
  void tail.then(() => {
    if (appServiceLocks.get(appId) === tail) appServiceLocks.delete(appId)
  })
  return run
}

/** The outcome of spawning one owner session. */
export type SpawnServiceOwnerResult =
  | { ok: true; sessionId: string; pid?: number; startTicks?: number }
  | { ok: false; error: string }

/** Spawn seam for one service owner — injectable so unit tests never spawn a
 *  real session. The default (app-tools.ts) goes through `spawnAgentSession`
 *  with `keepAlive` + a `restartPolicy`. */
export type SpawnServiceOwner = (input: {
  appId: string
  dir: string
  service: AppService
  workspaceSlug?: string
  /** Extra process env, e.g. `AGENTPROTO_PUBLIC_URL` of an exposed service. */
  env?: Record<string, string>
}) => Promise<SpawnServiceOwnerResult>

export interface EnsureAppServiceOwnersDeps {
  store: AppServiceStore
  appId: string
  services: AppServices
  /** Liveness of a recorded owner session — owned by the caller because the
   *  sessions registry lives there. */
  isOwnerAlive: (owner: AppServiceOwner) => boolean
  /** Spawn one owner. The caller binds app/dir/workspace — this module only
   *  knows the service entries and the ownership bookkeeping. */
  spawn: (service: AppService, extra?: { env?: Record<string, string> }) => Promise<SpawnServiceOwnerResult>
  /** Kill ONE owner: the owner session + its recorded pid. Best-effort, may
   *  be async. */
  killOwner: (owner: AppServiceOwner) => void | Promise<void>
  /** Clock seam for `startedAt` (tests). */
  now?: () => Date
  /** AIP-53 `expose`: tunnels for exposed services, ensured BEFORE their
   *  process spawns. Omitted: `expose` is ignored (nothing published). */
  exposer?: AppServiceExposer
}

export interface EnsureAppServiceOwnersResult {
  /** Owners newly spawned by THIS call. */
  spawned: AppServiceOwner[]
  /** Already-live owners left untouched (idempotence). */
  kept: AppServiceOwner[]
  /** Per-service spawn failures — surfaced, never thrown (a failed service
   *  must not fail the install that succeeded). */
  errors: Array<{ name: string; error: string }>
  /** Owners of services the manifest NO LONGER declares — killed and
   *  dropped by THIS call (full reconciliation; audit F-7: a purged
   *  manifest entry must not keep a live process across a reinstall). */
  removed: string[]
  /** Per exposed service: its tunnel, or why it failed (a failed tunnel
   *  never blocks the process). Present when an exposer is wired and the
   *  manifest exposes a service. */
  exposures?: AppServiceExposure[]
  /** Services whose tunnel THIS call deleted (service removed from the
   *  manifest, or its `expose` dropped). */
  unexposed?: string[]
}

/**
 * Ensure exactly one live owner per declared service (idempotent, "ensure"
 * semantics — mirroring `ensureAppWorkspace`), AND a full reconciliation of
 * the store against the declared set: every owner of an app whose service
 * was removed from the manifest is killed + dropped (`removed`).
 *
 *   - a service whose recorded owner is still alive is KEPT (no duplicate
 *     owner on reinstall / repeated `app_install`);
 *   - a service whose recorded owner is dead is replaced: the stale owner is
 *     killed + dropped, a fresh one is spawned;
 *   - a service with no record is spawned.
 *
 * The whole reconcile runs under the per-app lock (`withAppServiceLock`) —
 * a concurrent call waits its turn and re-reads the store, so it sees this
 * call's writes (no double-spawns).
 * Spawn failures are collected in `errors` and never abort the loop.
 */
export async function ensureAppServiceOwners(
  deps: EnsureAppServiceOwnersDeps,
): Promise<EnsureAppServiceOwnersResult> {
  return withAppServiceLock(deps.appId, async () => {
    const now = deps.now ?? (() => new Date())
    const existing = deps.store.listForApp(deps.appId)
    const byName = new Map(existing.map(o => [o.name, o]))
    const spawned: AppServiceOwner[] = []
    const kept: AppServiceOwner[] = []
    const errors: Array<{ name: string; error: string }> = []
    const removed: string[] = []

    // AIP-53 Exposure rule 3: tunnel before process. A running process
    // started with another origin than the current one (`expose` added, or
    // a provider that handed out a new URL) is restarted with the new env.
    // Only judged when an exposer is wired; a tunnel in error keeps the
    // process as is (a transient failure must not take a working service
    // down).
    const originIsStale = (owner: AppServiceOwner, exposure: AppServiceExposure | undefined): boolean => {
      if (deps.exposer === undefined) return false
      if (exposure?.state === "error") return false
      return owner.publicUrl !== exposure?.publicUrl
    }
    // Tunnels are ensured for kept owners too (idempotent on the key: same
    // tunnel back, restarted if it is down).
    const exposures: AppServiceExposure[] = []
    const exposureByName = new Map<string, AppServiceExposure>()
    if (deps.exposer !== undefined) {
      for (const service of deps.services) {
        if (!isExposedService(service)) continue
        const exposure = await deps.exposer.ensure(deps.appId, service)
        exposures.push(exposure)
        exposureByName.set(service.name, exposure)
      }
    }

    for (const service of deps.services) {
      const prev = byName.get(service.name)
      if (prev !== undefined && deps.isOwnerAlive(prev) && !originIsStale(prev, exposureByName.get(service.name))) {
        kept.push(prev)
        continue
      }
      if (prev !== undefined) {
        try {
          await deps.killOwner(prev)
        } catch {
          // A failed kill of a dead owner must not block the replacement.
        }
        deps.store.remove(deps.appId, service.name)
      }
      const env = exposureEnv(exposureByName.get(service.name))
      const res = await deps.spawn(service, Object.keys(env).length > 0 ? { env } : undefined)
      if (!res.ok) {
        errors.push({ name: service.name, error: res.error })
        continue
      }
      const owner: AppServiceOwner = {
        appId: deps.appId,
        name: service.name,
        entry: serviceDisplayEntry(service),
        sessionId: res.sessionId,
        ...(res.pid !== undefined ? { pid: res.pid } : {}),
        ...(res.startTicks !== undefined ? { startTicks: res.startTicks } : {}),
        ...(service.port !== undefined ? { port: service.port } : {}),
        ...(env[APP_SERVICE_PUBLIC_URL_ENV] !== undefined ? { publicUrl: env[APP_SERVICE_PUBLIC_URL_ENV] } : {}),
        startedAt: now().toISOString(),
      }
      deps.store.upsert(owner)
      spawned.push(owner)
    }

    // Full reconciliation (F-7): every recorded owner the manifest no longer
    // declares is stopped and dropped.
    const declared = new Set(deps.services.map(s => s.name))
    for (const orphan of deps.store.listForApp(deps.appId)) {
      if (declared.has(orphan.name)) continue
      try {
        await deps.killOwner(orphan)
      } catch {
        // Best-effort — still drop the record.
      }
      deps.store.remove(deps.appId, orphan.name)
      removed.push(orphan.name)
    }

    // AIP-53 Exposure rule 7: a service removed from the manifest, or one
    // that dropped `expose`, loses its tunnel (connector stopped, deleted).
    const unexposed: string[] = []
    if (deps.exposer !== undefined) {
      const exposed = new Set(deps.services.filter(isExposedService).map(s => s.name))
      for (const name of deps.exposer.list(deps.appId)) {
        if (exposed.has(name)) continue
        try {
          await deps.exposer.remove(deps.appId, name)
          unexposed.push(name)
        } catch (err) {
          // The registry keeps the descriptor with `lastError` for a retry.
          console.warn(
            `[app-services] tunnel of "${deps.appId}:${name}" not deleted: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }

    return {
      spawned,
      kept,
      errors,
      removed,
      ...(exposures.length > 0 ? { exposures } : {}),
      ...(unexposed.length > 0 ? { unexposed } : {}),
    }
  })
}

/**
 * Boot counterpart of `ensureAppServiceOwners` (Pygmalion phase 1b item 2):
 * the previous daemon's owner rows are gone by definition, so every recorded
 * owner is treated as stale and replaced — liveness is NOT consulted (a
 * rehydrated registry row reports `running` while its process may be dead —
 * the exact state an `isOwnerAlive`-gated re-ensure would KEEP and never
 * fix). Leftover children from the previous daemon are killed through the
 * replacement path itself: `killOwner` (see `killServiceProcess`) signals the
 * RECORDED pid's process group, so a detached child that outlived the
 * daemon does not hold its port against the fresh owner.
 */
export async function reensureAppServiceOwners(
  deps: ReensureAppServiceOwnersDeps,
): Promise<EnsureAppServiceOwnersResult> {
  return ensureAppServiceOwners({
    store: deps.store,
    appId: deps.appId,
    services: deps.services,
    isOwnerAlive: () => false,
    spawn: deps.spawn,
    killOwner: deps.killOwner,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.exposer ? { exposer: deps.exposer } : {}),
  })
}

export interface ReensureAppServiceOwnersDeps extends Omit<EnsureAppServiceOwnersDeps, "isOwnerAlive"> {}

/**
 * Remove + kill every owner of an app — the `app_uninstall` cleanup. Kills
 * each owner session/pid (via `killOwner`) and drops the records, so a
 * subsequent reinstall starts clean. Returns the removed service names.
 * Never throws on an individual kill failure.
 */
export async function removeAppServiceOwners(deps: {
  store: AppServiceStore
  appId: string
  killOwner: (owner: AppServiceOwner) => void | Promise<void>
  /** AIP-53 Exposure rule 7: every tunnel of the app is deleted too. */
  exposer?: AppServiceExposer
}): Promise<string[]> {
  return withAppServiceLock(deps.appId, async () => {
    const owners = deps.store.listForApp(deps.appId)
    const removed: string[] = []
    for (const owner of owners) {
      try {
        await deps.killOwner(owner)
      } catch {
        // Best-effort — still drop the record.
      }
      deps.store.remove(deps.appId, owner.name)
      removed.push(owner.name)
    }
    if (deps.exposer !== undefined) {
      for (const name of deps.exposer.list(deps.appId)) {
        try {
          await deps.exposer.remove(deps.appId, name)
        } catch (err) {
          // The registry keeps the descriptor with `lastError` for a retry.
          console.warn(
            `[app-services] tunnel of "${deps.appId}:${name}" not deleted: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }
    return removed
  })
}
