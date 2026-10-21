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
 * spawn. `services:` validation itself now delegates to app-kit's
 * `parseServiceList` — the single validator for the manifest `services:`
 * array, shared with `defineApp`/`loadAppHandle`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parseServiceList, type AppService } from "@agentproto/app-kit"

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
 * app-kit's `parseServiceList`, the single validator shared with
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
  /** Mirrors the declared `port` for bookkeeping. */
  port?: number
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

export function createAppServiceStore(opts?: {
  persistPath?: string
  persist?: boolean
}): AppServiceStore {
  const persistPath = opts?.persistPath ?? DEFAULT_SERVICE_STORE_PATH()
  const shouldPersist = opts?.persist ?? opts?.persistPath !== undefined
  const state = shouldPersist ? loadServiceState(persistPath) : { version: 1 as const, owners: [] as AppServiceOwner[] }
  const persist = (): void => {
    if (shouldPersist) saveServiceState(state, persistPath)
  }
  return {
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
}

// ── orchestration ───────────────────────────────────────────────────────────

/** The outcome of spawning one owner session. */
export type SpawnServiceOwnerResult =
  | { ok: true; sessionId: string; pid?: number }
  | { ok: false; error: string }

/** Spawn seam for one service owner — injectable so unit tests never spawn a
 *  real session. The default (app-tools.ts) goes through `spawnAgentSession`
 *  with `keepAlive` + a `restartPolicy`. */
export type SpawnServiceOwner = (input: {
  appId: string
  dir: string
  service: AppService
  workspaceSlug?: string
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
  spawn: (service: AppService) => Promise<SpawnServiceOwnerResult>
  /** Kill ONE owner: the owner session + its recorded pid. Best-effort, may
   *  be async. */
  killOwner: (owner: AppServiceOwner) => void | Promise<void>
  /** Clock seam for `startedAt` (tests). */
  now?: () => Date
}

export interface EnsureAppServiceOwnersResult {
  /** Owners newly spawned by THIS call. */
  spawned: AppServiceOwner[]
  /** Already-live owners left untouched (idempotence). */
  kept: AppServiceOwner[]
  /** Per-service spawn failures — surfaced, never thrown (a failed service
   *  must not fail the install that succeeded). */
  errors: Array<{ name: string; error: string }>
}

/**
 * Ensure exactly one live owner per declared service (idempotent, "ensure"
 * semantics — mirroring `ensureAppWorkspace`):
 *
 *   - a service whose recorded owner is still alive is KEPT (no duplicate
 *     owner on reinstall / repeated `app_install`);
 *   - a service whose recorded owner is dead is replaced: the stale owner is
 *     killed + dropped, a fresh one is spawned;
 *   - a service with no record is spawned.
 *
 * Spawn failures are collected in `errors` and never abort the loop.
 */
export async function ensureAppServiceOwners(
  deps: EnsureAppServiceOwnersDeps,
): Promise<EnsureAppServiceOwnersResult> {
  const now = deps.now ?? (() => new Date())
  const existing = deps.store.listForApp(deps.appId)
  const byName = new Map(existing.map(o => [o.name, o]))
  const spawned: AppServiceOwner[] = []
  const kept: AppServiceOwner[] = []
  const errors: Array<{ name: string; error: string }> = []

  for (const service of deps.services) {
    const prev = byName.get(service.name)
    if (prev !== undefined && deps.isOwnerAlive(prev)) {
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
    const res = await deps.spawn(service)
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
      ...(service.port !== undefined ? { port: service.port } : {}),
      startedAt: now().toISOString(),
    }
    deps.store.upsert(owner)
    spawned.push(owner)
  }

  return { spawned, kept, errors }
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
}): Promise<string[]> {
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
  return removed
}
