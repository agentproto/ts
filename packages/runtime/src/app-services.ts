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
 * One owner SESSION per entry (the SAME spawn infra as agents — see
 * `registerAppTools`'s wiring in app-tools.ts) runs `entry` as a detached
 * child and supervises it: it restarts the child when it dies, and the owner
 * session itself is spawned with `keepAlive` + a `restartPolicy` so the daemon
 * revives it if the owner crashes. There is deliberately NO scheduler here —
 * no cron, no k8s, no queue: just one owner session per declared service.
 *
 * Ownership is persisted (appId + name + entry + owner `sessionId` + the
 * child/session `pid`, in a JSON store next to the installed-app registry) so
 * `app_uninstall` can (a) kill every owner session and (b) kill the recorded
 * process — otherwise a reinstall spawns a second owner for a service still
 * running from the old install ("double-cerveau à la réinstall").
 *
 * Scope note: this module is the whole SERVICE-LAUNCHER behaviour, lifted out
 * of app-tools.ts so it is unit-testable without an MCP server or a real
 * spawn. The `AppService` type is intentionally defined here with EXACTLY the
 * frozen keys (`name`, `entry`, `port`) so that when the app-kit
 * `services:`-parsing PR lands, swapping to the app-kit type is a one-line
 * change.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * One declared service (frozen semantics): a kebab-slug `name`, the shell
 * `entry` command to run, and an optional `port` (1..65535) kept as
 * bookkeeping + a health touchpoint — the child binds whatever port its entry
 * decides; the daemon never probes it today (acceptance is ownership +
 * restart).
 */
export interface AppService {
  name: string
  entry: string
  port?: number
}

/** The manifest's `services:` list. */
export type AppServices = readonly AppService[]

/** The only key set the frozen semantics allow — a malformed block fails the
 *  install rather than silently launching a partial service set. */
export interface AppServiceValidation {
  services: AppService[]
  errors: string[]
}

const KEBAB_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Validate a raw APP.md `services` frontmatter value against the frozen
 * semantics. `undefined` (no block) yields `{ services: [], errors: [] }` —
 * the launcher's no-op case, so an app WITHOUT `services` is byte-for-byte
 * unaffected. Any other malformed value returns one or more `errors` and the
 * caller refuses the install.
 */
export function parseAppServices(raw: unknown): AppServiceValidation {
  if (raw === undefined || raw === null) return { services: [], errors: [] }
  if (!Array.isArray(raw)) {
    return { services: [], errors: ["frontmatter 'services' must be an array."] }
  }
  const services: AppService[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  raw.forEach((entry, i) => {
    const at = `services[${i}]`
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`${at} must be an object with { name, entry, port? }.`)
      return
    }
    const e = entry as Record<string, unknown>
    const name = e.name
    const entryCmd = e.entry
    const port = e.port
    if (typeof name !== "string" || !KEBAB_SLUG.test(name)) {
      errors.push(`${at}.name must be a kebab-case slug (got ${JSON.stringify(name)}).`)
      return
    }
    if (seen.has(name)) {
      errors.push(`${at}.name "${name}" is duplicated — service names must be unique per app.`)
      return
    }
    if (typeof entryCmd !== "string" || entryCmd.trim() === "") {
      errors.push(`${at}.entry must be a non-empty shell command.`)
      return
    }
    let validatedPort: number | undefined
    if (port !== undefined) {
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
        errors.push(`${at}.port must be an integer in 1..65535 (got ${JSON.stringify(port)}).`)
        return
      }
      validatedPort = port
    }
    seen.add(name)
    services.push({ name, entry: entryCmd, ...(validatedPort !== undefined ? { port: validatedPort } : {}) })
  })
  return { services, errors }
}

/** One service owner: the persisted ownership record — `appId` + the service
 *  `name`/`entry` + the owner session id and the recorded process `pid`, so
 *  uninstall can find and kill both. */
export interface AppServiceOwner {
  appId: string
  name: string
  entry: string
  /** The spawned owner session id (`app_uninstall` kills it). */
  sessionId: string
  /** The owner/session process id, when the spawn surfaced one — the primary
   *  pid-bookkeeping handle `app_uninstall` signals. */
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
 * The owner session's job, spelled out as its first prompt: run `entry` as a
 * detached child, write the child pid to `pidFile`, and restart the child when
 * it dies. The daemon does NOT loop this itself — the owner is the supervisor
 * (the simplest path the repo already has: one agent session, `keepAlive` +
 * `restartPolicy` at the daemon level, a shell supervision loop inside).
 */
export function buildServiceOwnerPrompt(service: AppService, pidFile: string): string {
  const portNote =
    service.port !== undefined ? ` It is expected to listen on port ${service.port}.` : ""
  return [
    `You are the service owner for "${service.name}".`,
    `Run this command as a detached background child and keep it alive, restarting it whenever it exits:`,
    "",
    `    ${service.entry}`,
    "",
    `Write the child's PID to ${pidFile} immediately after launching it, and treat that pid file as the daemon's handle to this service.${portNote}`,
    "Use a small supervision loop (relaunch on exit) rather than exiting; this session stays alive for the lifetime of the service and is killed by `app_uninstall`.",
    "Do not spawn any additional long-running processes beyond this one service.",
  ].join("\n")
}

/** Absolute path of the pid file an owner writes for its service (kept beside
 *  the app's daemon-owned state so no path is caller-supplied). */
export function servicePidFilePath(stateDir: string, name: string): string {
  return join(stateDir, "services", `${name}.pid`)
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

/**
 * Read the pid an owner wrote to its pid file (`servicePidFilePath`), or
 * `undefined` when the file is absent or malformed. This is the ONLY handle to
 * the `entry` CHILD process: the owner record's own `pid` is the owner
 * session's, and the owner session is gone by the time the boot re-ensure runs
 * (`reensureAppServiceOwners`) — so a child that outlived the daemon would
 * otherwise hold its port against the replacement.
 */
export function readServicePidFile(pidFile: string): number | undefined {
  try {
    const raw = readFileSync(pidFile, "utf8").trim()
    // Strict digits-only: `Number.parseInt` alone would read "42junk" as 42
    // and signal it — a malformed file must read as absent, not as a pid.
    if (!/^\d+$/.test(raw)) return undefined
    const pid = Number.parseInt(raw, 10)
    return pid > 0 ? pid : undefined
  } catch {
    return undefined
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
      entry: service.entry,
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
 * the previous daemon's owner sessions are gone by definition, so every
 * recorded owner is treated as stale and replaced — liveness is NOT consulted.
 * That is the whole point: a rehydrated (or eagerly re-resumed) owner session
 * reports `running` while its `entry` child is dead, the exact state an
 * `isOwnerAlive`-gated re-ensure would KEEP and never fix. Before spawning,
 * signal the pid the owner left in its pid file, so a child that outlived the
 * daemon does not hold its port against the fresh owner.
 */
export async function reensureAppServiceOwners(
  deps: ReensureAppServiceOwnersDeps,
): Promise<EnsureAppServiceOwnersResult> {
  const readPid = deps.readPidFile ?? readServicePidFile
  const killPid = deps.killPid ?? killServicePid
  for (const service of deps.services) {
    killPid(readPid(servicePidFilePath(deps.stateDir, service.name)))
  }
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

export interface ReensureAppServiceOwnersDeps extends Omit<EnsureAppServiceOwnersDeps, "isOwnerAlive"> {
  /** Per-app state dir the owner writes its `<name>.pid` under (the same dir
   *  `ensureServices` derives: `stateDir ?? dataDir ?? dir`). */
  stateDir: string
  /** Test seams — default to the real pid-file read + `killServicePid`. */
  readPidFile?: (pidFile: string) => number | undefined
  killPid?: (pid: number | undefined) => void
}

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
