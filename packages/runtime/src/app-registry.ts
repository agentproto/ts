/**
 * Persisted installed-app + app-run state for the `app_*` daemon verbs
 * (app-tools.ts). Mirrors workflow-runner.ts's persistence pattern exactly:
 * an in-memory store, write-tmp + rename on every mutation, and persistence
 * OFF by default so unit tests never touch ~/.agentproto/.
 */

import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs"

/** A ref pair as materialized by `@agentproto/app-kit`'s `emit` — an
 *  agent/workflow id plus the absolute path to its manifest on disk. */
export interface InstalledAppRef {
  readonly id: string
  readonly path: string
}

export interface InstalledApp {
  readonly appId: string
  readonly dir: string
  readonly version?: string
  readonly name?: string
  readonly description?: string
  readonly agents: readonly InstalledAppRef[]
  readonly workflows: readonly InstalledAppRef[]
  /** Agent-declared (AIP-14) tool refs — the adapter's business, never
   *  validated at install time. Surfaced for visibility only. */
  readonly unvalidatedAgentTools: readonly string[]
  readonly requires?: readonly string[]
  readonly ui?: {
    readonly path: string
    readonly title?: string
    readonly description?: string
    readonly tools?: readonly string[]
    readonly csp?: {
      readonly connectDomains?: readonly string[]
      readonly resourceDomains?: readonly string[]
    }
  }
  readonly artifacts?: readonly { readonly type: string; readonly description?: string }[]
  readonly dev?: {
    readonly launch: readonly {
      readonly name: string
      readonly runtimeExecutable: string
      readonly runtimeArgs?: readonly string[]
      readonly port?: number
      readonly url?: string
    }[]
  }
  readonly installedAt: string
  readonly updatedAt: string
}

export interface AppRunSession {
  readonly agentId: string
  readonly sessionId: string
}

export interface AppRun {
  readonly appRunId: string
  readonly appId: string
  readonly sessions: readonly AppRunSession[]
  readonly startedAt: string
  status: "running" | "stopped"
  endedAt?: string
}

export interface AppliedMount {
  readonly scopeId: string
  readonly appId: string
  readonly appliedAt: string
}

interface AppRegistryState {
  apps: InstalledApp[]
  runs: AppRun[]
  applied: AppliedMount[]
}

export interface AppRegistry {
  /** Insert or, keyed by `appId`, fully replace an installed-app record. */
  upsertApp(
    input: Omit<InstalledApp, "installedAt" | "updatedAt">,
  ): InstalledApp
  getApp(appId: string): InstalledApp | undefined
  listApps(): InstalledApp[]
  /** Remove an installed-app record. Returns the removed record, or
   *  undefined if no app with that id was installed. Callers (app_uninstall)
   *  are responsible for checking there's no applied mount / running run
   *  first — this does no such validation itself. */
  removeApp(appId: string): InstalledApp | undefined
  createRun(input: { appId: string; sessions: readonly AppRunSession[] }): AppRun
  getRun(appRunId: string): AppRun | undefined
  listRuns(): AppRun[]
  /** Mark a run "stopped" with `endedAt` now. No-op (returns undefined) for
   *  an unknown appRunId. */
  endRun(appRunId: string): AppRun | undefined
  /** Apply an app to a scope (idempotent upsert per scopeId+appId pair). */
  applyApp(input: { scopeId: string; appId: string }): AppliedMount
  /** Remove a scope mount. Returns the removed mount or undefined if not applied. */
  unapplyApp(input: { scopeId: string; appId: string }): AppliedMount | undefined
  /** List applied mounts, optionally filtered by scopeId. */
  listApplied(scopeId?: string): AppliedMount[]
}

const DEFAULT_PERSIST_PATH = (): string => join(homedir(), ".agentproto", "apps.json")

function loadState(persistPath: string): AppRegistryState {
  const empty: AppRegistryState = { apps: [], runs: [], applied: [] }
  if (!existsSync(persistPath)) return empty
  let raw: string
  try {
    raw = readFileSync(persistPath, "utf8")
  } catch {
    return empty
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AppRegistryState>
    return {
      apps: Array.isArray(parsed.apps) ? parsed.apps : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      applied: Array.isArray(parsed.applied) ? parsed.applied : [],
    }
  } catch {
    return empty
  }
}

function saveState(state: AppRegistryState, persistPath: string): void {
  try {
    mkdirSync(dirname(persistPath), { recursive: true })
    const tmp = `${persistPath}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8")
    renameSync(tmp, persistPath)
  } catch {
    // Best-effort — a write failure must not crash the daemon.
  }
}

export function createAppRegistry(opts?: {
  persistPath?: string
  persist?: boolean
}): AppRegistry {
  const persistPath = opts?.persistPath ?? DEFAULT_PERSIST_PATH()
  const shouldPersist = opts?.persist ?? opts?.persistPath !== undefined
  const state: AppRegistryState = shouldPersist
    ? loadState(persistPath)
    : { apps: [], runs: [], applied: [] }

  const persist = (): void => {
    if (shouldPersist) saveState(state, persistPath)
  }

  return {
    upsertApp(input) {
      const now = new Date().toISOString()
      const idx = state.apps.findIndex(a => a.appId === input.appId)
      const record: InstalledApp = {
        ...input,
        installedAt: idx === -1 ? now : state.apps[idx]!.installedAt,
        updatedAt: now,
      }
      if (idx === -1) state.apps.push(record)
      else state.apps[idx] = record
      persist()
      return record
    },
    getApp(appId) {
      return state.apps.find(a => a.appId === appId)
    },
    listApps() {
      return [...state.apps]
    },
    removeApp(appId) {
      const idx = state.apps.findIndex(a => a.appId === appId)
      if (idx === -1) return undefined
      const [removed] = state.apps.splice(idx, 1)
      persist()
      return removed
    },
    createRun(input) {
      const run: AppRun = {
        appRunId: `apprun_${randomUUID()}`,
        appId: input.appId,
        sessions: input.sessions,
        startedAt: new Date().toISOString(),
        status: "running",
      }
      state.runs.push(run)
      persist()
      return run
    },
    getRun(appRunId) {
      return state.runs.find(r => r.appRunId === appRunId)
    },
    listRuns() {
      return [...state.runs]
    },
    endRun(appRunId) {
      const run = state.runs.find(r => r.appRunId === appRunId)
      if (!run) return undefined
      run.status = "stopped"
      run.endedAt = new Date().toISOString()
      persist()
      return run
    },
    applyApp(input) {
      const idx = state.applied.findIndex(
        m => m.scopeId === input.scopeId && m.appId === input.appId
      )
      const mount: AppliedMount = {
        scopeId: input.scopeId,
        appId: input.appId,
        appliedAt: idx === -1 ? new Date().toISOString() : state.applied[idx]!.appliedAt,
      }
      if (idx === -1) state.applied.push(mount)
      else state.applied[idx] = mount
      persist()
      return mount
    },
    unapplyApp(input) {
      const idx = state.applied.findIndex(
        m => m.scopeId === input.scopeId && m.appId === input.appId
      )
      if (idx === -1) return undefined
      const removed = state.applied[idx]!
      state.applied.splice(idx, 1)
      persist()
      return removed
    },
    listApplied(scopeId) {
      if (scopeId === undefined) return [...state.applied]
      return state.applied.filter(m => m.scopeId === scopeId)
    },
  }
}
