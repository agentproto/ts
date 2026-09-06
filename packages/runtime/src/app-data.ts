/**
 * App-scoped durable data plane — path-traversal-guarded read/write/list
 * tools anchored under an installed app's DATA directory (`dataDir` on the
 * `AppRegistry` record, default `<dir>/data`), plus a one-time migration of
 * legacy job-app data into the durable shape.
 *
 * Tools:
 *   app_data_read     read a file (JSON-parsed when it ends in `.json`)
 *   app_data_write    atomic write, JSON-stringified for `.json` paths
 *   app_data_list     list entries under an app-relative dir
 *   app_data_migrate  import legacy `ranked-jobs.json` + `dossiers/*` data
 *   app_state_append  append a validated event to the app's state ledger
 *                     (app-state.ts) — NOT granted to agent sessions (see
 *                     app-state.ts's access rule); runner + UI only
 *   app_state_get     fold the ledger to a snapshot + last N events
 *   app_state_list    filtered event listing (stage/item/kinds/since/limit)
 *
 * Unlike the generic fs-tools (workspace-rooted), everything here resolves
 * strictly under the app's data dir (or, for legacy files, its source dir)
 * and refuses to escape either.
 *
 * ## Resolution rule (the contract app UIs and agents rely on)
 *
 * An app-relative path `p` resolves as follows — see `locateAppDataPath`:
 *
 * 1. **Primary root is `dataDir`** — `InstalledApp.dataDir`, defaulting to
 *    `<dir>/data` for records that predate the field. Custom roots are set
 *    with `app_install {dataDir}` / `agentproto app install --data-dir`, or
 *    hinted by APP.md `data: { dir }` (relative to the app dir).
 * 2. **Legacy `data/` spelling collapses under the default layout.** Before
 *    `dataDir` existed the plane was anchored at `<dir>` and apps addressed
 *    files as `data/...`. When `dataDir` IS `<dir>/data`, a leading `data/`
 *    segment is redundant and dropped: `data/trips/x.json` and
 *    `trips/x.json` name the same file, for reads and writes alike. (A
 *    custom `dataDir` is a fresh, intentional layout — no collapse.)
 * 3. **Legacy root fallback.** If `p` — or its top-level folder — does not
 *    exist under `dataDir` but does under the app's source `dir`, it
 *    resolves under `dir`: reads find files written by pre-`dataDir`
 *    installs, writes update them in place (or land next to their
 *    siblings), and `app_data_list` merges both views. Move the folder into
 *    `dataDir` and the fallback stops applying. Brand-new paths always land
 *    under `dataDir`.
 *
 * Both roots get the same defence: `resolveAppDataPath` (no absolute paths,
 * no drive letters, no `..` climbing) plus a realpath check so a symlink
 * inside either root can never point outside it.
 *
 * Reserved: a future `store.sqlite` inside `dataDir`, exposed through an
 * `app_data_query` tool — not implemented here, but the data dir is where it
 * will live, which is one reason it must be separable from the source tree.
 */

import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path"
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { AppRegistry, InstalledApp } from "./app-registry.js"
import {
  APP_STATE_APPEND_TOOL_NAME,
  APP_STATE_KINDS,
  appendAppStateEvent,
  appStateEventInputSchema,
  appStateSnapshot,
  readAppStateEvents,
} from "./app-state.js"
import type { AppStateEvent } from "./app-state.js"
import { paginate, pageParamsShape, toolText } from "./tool-envelope.js"

/** Thrown when a relative app path resolves outside the app's own directory. */
export class AppPathTraversalError extends Error {
  readonly code = "APP_PATH_TRAVERSAL"
  constructor(relPath: string) {
    super(`app-data: path traversal rejected for "${relPath}" — must resolve inside the app dir.`)
    this.name = "AppPathTraversalError"
  }
}

/** The sub-directory of the app dir the data plane defaults to. */
export const DEFAULT_APP_DATA_SUBDIR = "data"

/** Absolute data root for an installed app: its persisted `dataDir`, else
 *  the default `<dir>/data` (records written before the field existed). */
export function appDataDir(app: Pick<InstalledApp, "dir" | "dataDir">): string {
  return app.dataDir ?? join(app.dir, DEFAULT_APP_DATA_SUBDIR)
}

/** True when the app's data root is the default `<dir>/data` — the only
 *  layout under which the legacy `data/` spelling is collapsed. */
export function isDefaultAppDataLayout(app: Pick<InstalledApp, "dir" | "dataDir">): boolean {
  return resolve(appDataDir(app)) === resolve(app.dir, DEFAULT_APP_DATA_SUBDIR)
}

/** Drop a redundant leading `data/` segment (rule 2 above). Pure string
 *  work on the normalized path — the traversal guard still runs on the
 *  result, so `data/../../x` is rejected exactly as `../x` would be. */
export function collapseLegacyDataPrefix(relPath: string): string {
  const n = normalize(relPath)
  if (n === DEFAULT_APP_DATA_SUBDIR) return "."
  const prefix = DEFAULT_APP_DATA_SUBDIR + sep
  if (n.startsWith(prefix)) {
    const rest = n.slice(prefix.length)
    return rest === "" ? "." : rest
  }
  return relPath
}

// Invariant: the only path-escape defence that matters.
// `resolve` collapses `..` and `.` segments, so the only reliable check is
// that the resolved target is `root` itself or strictly below it. Without
// this a relative `../../secret` (or a nested `a/../../b`) silently climbs
// out of the app dir into unrelated host files.
export function resolveAppDataPath(appDir: string, relPath: string): string {
  if (isAbsolute(relPath)) throw new AppPathTraversalError(relPath)
  // Reject drive-letter prefixes so a Windows-form "C:foo" can never be
  // misinterpreted as a relative segment on a drive-based host.
  if (/^[A-Za-z]:/.test(relPath)) throw new AppPathTraversalError(relPath)
  const root = resolve(appDir)
  const target = resolve(appDir, relPath)
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new AppPathTraversalError(relPath)
  }
  return target
}

/** The two roots an app-relative path may resolve under. */
export interface AppDataRoots {
  /** Data root (rule 1) — realpath'd when it exists, else the resolved
   *  absolute path it will be created at. */
  readonly dataRoot: string
  readonly dataRootExists: boolean
  /** The app's source dir (rule 3), realpath'd. Undefined when it is gone
   *  — then only the data root is consulted. */
  readonly legacyRoot: string | undefined
  /** Whether rule 2 (`data/` prefix collapse) applies. */
  readonly defaultLayout: boolean
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function realpathMaybe(p: string): Promise<string | undefined> {
  try {
    return await realpath(p)
  } catch {
    return undefined
  }
}

/** Resolve both roots for an installed app. With `ensureDataDir`, the data
 *  dir is created first (the write path) so it can be realpath-normalized. */
export async function resolveAppDataRoots(
  app: Pick<InstalledApp, "dir" | "dataDir">,
  opts?: { ensureDataDir?: boolean },
): Promise<AppDataRoots> {
  const dataDir = resolve(appDataDir(app))
  if (opts?.ensureDataDir) await mkdir(dataDir, { recursive: true })
  const realData = await realpathMaybe(dataDir)
  const legacyRoot = await realpathMaybe(app.dir)
  return {
    dataRoot: realData ?? dataDir,
    dataRootExists: realData !== undefined,
    legacyRoot,
    defaultLayout: isDefaultAppDataLayout(app),
  }
}

/** Best-effort symlink escape defence for an existing target — realpath the
 *  file/dir and assert it still lands inside `root`. */
async function assertRealInside(root: string, target: string): Promise<void> {
  let real: string
  try {
    real = await realpath(target)
  } catch {
    return
  }
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (real !== root && !real.startsWith(rootWithSep)) {
    throw new AppPathTraversalError(target)
  }
}

export interface LocatedAppDataPath {
  /** Absolute path the app-relative input resolves to. */
  readonly target: string
  /** The root it was resolved under (`dataRoot` or `legacyRoot`). */
  readonly root: string
  /** True when rule 3 kicked in (resolved under the app's source dir). */
  readonly legacy: boolean
  /** Same-relative-path twin under the OTHER root, when it exists too —
   *  `app_data_list` merges the two directory views. */
  readonly sibling?: string
}

function firstSegment(rel: string): string | undefined {
  const n = normalize(rel)
  const seg = n.split(sep).find(s => s !== "" && s !== ".")
  return seg === undefined || seg === ".." ? undefined : seg
}

/**
 * Apply the resolution rule to one app-relative path. Throws
 * `AppPathTraversalError` when the path escapes whichever root it lands
 * under; never creates anything.
 */
export async function locateAppDataPath(roots: AppDataRoots, relPath: string): Promise<LocatedAppDataPath> {
  const rel = roots.defaultLayout ? collapseLegacyDataPrefix(relPath) : relPath
  const primary = resolveAppDataPath(roots.dataRoot, rel)
  await assertRealInside(roots.dataRoot, primary)
  const primaryExists = await pathExists(primary)

  // Rule 3 — the legacy root is consulted with the path AS SPELLED by the
  // caller (pre-dataDir installs anchored `<dir>/<relPath>` verbatim).
  let legacyTarget: string | undefined
  if (roots.legacyRoot !== undefined) {
    try {
      legacyTarget = resolveAppDataPath(roots.legacyRoot, relPath)
    } catch {
      legacyTarget = undefined
    }
    if (legacyTarget === primary) legacyTarget = undefined
  }
  let legacyExists = false
  if (legacyTarget !== undefined) {
    await assertRealInside(roots.legacyRoot!, legacyTarget)
    legacyExists = await pathExists(legacyTarget)
  }

  if (primaryExists) {
    return {
      target: primary,
      root: roots.dataRoot,
      legacy: false,
      ...(legacyExists && legacyTarget !== undefined ? { sibling: legacyTarget } : {}),
    }
  }
  if (legacyExists && legacyTarget !== undefined) {
    return { target: legacyTarget, root: roots.legacyRoot!, legacy: true }
  }

  // Neither exists yet: a brand-new path lands under the data root — unless
  // its top-level folder already lives under the legacy root and not under
  // the data root, in which case it joins its siblings there.
  const top = firstSegment(relPath)
  if (top !== undefined && roots.legacyRoot !== undefined && legacyTarget !== undefined) {
    const primaryTop = resolveAppDataPath(roots.dataRoot, roots.defaultLayout ? collapseLegacyDataPrefix(top) : top)
    const legacyTop = resolveAppDataPath(roots.legacyRoot, top)
    if (legacyTop !== primaryTop && !(await pathExists(primaryTop)) && (await pathExists(legacyTop))) {
      return { target: legacyTarget, root: roots.legacyRoot, legacy: true }
    }
  }
  return { target: primary, root: roots.dataRoot, legacy: false }
}

function textResult(body: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(body) }] }
}

function errorResult(text: string): {
  content: { type: "text"; text: string }[]
  isError: true
} {
  return { content: [{ type: "text", text: JSON.stringify({ error: text }) }], isError: true }
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}`
  await writeFile(tmp, data, "utf8")
  await rename(tmp, filePath)
}

async function writeRaw(roots: AppDataRoots, rel: string, data: string): Promise<void> {
  await atomicWrite((await locateAppDataPath(roots, rel)).target, data)
}

async function writeJson(roots: AppDataRoots, rel: string, value: unknown): Promise<void> {
  await writeRaw(roots, rel, JSON.stringify(value, null, 2) + "\n")
}

async function readTextMaybe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

async function readJsonMaybe(path: string): Promise<unknown> {
  const raw = await readTextMaybe(path)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

interface LegacyRankedJob {
  jobId?: unknown
  id?: unknown
  title?: unknown
  company?: unknown
  location?: unknown
  description?: unknown
  score?: unknown
  tier?: unknown
  rationale?: unknown
  fitSignals?: unknown
  concerns?: unknown
  url?: unknown
  [key: string]: unknown
}

/** Normalize a legacy ranked job into the durable shape: `id` === `jobId`
 *  (both present), `applyUrl` derived from `url` when absent, `url` kept. */
function normalizeJob(raw: LegacyRankedJob): Record<string, unknown> {
  const jobId = raw.jobId ?? raw.id
  const out: Record<string, unknown> = { ...raw, id: jobId, jobId }
  if (out.applyUrl === undefined || out.applyUrl === null) out.applyUrl = raw.url
  return out
}

async function readDossierJobId(dossierDir: string): Promise<string | undefined> {
  const parsed = (await readJsonMaybe(join(dossierDir, "job.json"))) as
    | { jobId?: unknown; id?: unknown }
    | undefined
  if (!parsed || typeof parsed !== "object") return undefined
  const jobId = parsed.jobId ?? parsed.id
  return typeof jobId === "string" && jobId.length > 0 ? jobId : undefined
}

export interface RegisterAppDataToolsOptions {
  appRegistry: AppRegistry
}

export function registerAppDataTools(server: McpServer, opts: RegisterAppDataToolsOptions): void {
  const { appRegistry } = opts

  server.tool(
    "app_data_read",
    "Read an app-scoped data file (app-relative path). JSON paths return the " +
      "parsed value in `content`; everything else returns the raw text. Paths " +
      "resolve under the app's data dir (`dataDir`, default `<dir>/data`); " +
      "under the default layout a leading `data/` is accepted as the legacy " +
      "spelling, and a file that only exists under the app's source dir (a " +
      "pre-dataDir install) is still found there. Path traversal outside " +
      "either root is rejected.",
    { appId: z.string(), path: z.string().describe("App-relative path under the app's data dir.") },
    async input => {
      const installed = appRegistry.getApp(input.appId)
      if (!installed) return errorResult(`app_data_read: no installed app "${input.appId}".`)
      let target: string
      try {
        const roots = await resolveAppDataRoots(installed)
        target = (await locateAppDataPath(roots, input.path)).target
      } catch (err) {
        return errorResult(`app_data_read: ${err instanceof Error ? err.message : String(err)}`)
      }
      const raw = await readTextMaybe(target)
      if (raw === undefined) return textResult({ appId: input.appId, path: input.path, exists: false })
      if (input.path.endsWith(".json")) {
        try {
          return textResult({ appId: input.appId, path: input.path, exists: true, content: JSON.parse(raw) })
        } catch {
          return textResult({ appId: input.appId, path: input.path, exists: true, content: raw })
        }
      }
      return textResult({ appId: input.appId, path: input.path, exists: true, content: raw })
    },
  )

  server.tool(
    "app_data_write",
    "Write an app-scoped data file (app-relative path), creating parent " +
      "directories as needed. `.json` paths are JSON-stringified (pretty); " +
      "other paths write the raw string passed as `content.text` (or a plain " +
      "string `content`). Atomic write (tmp + rename). New files land under " +
      "the app's data dir (`dataDir`, default `<dir>/data`); a file (or " +
      "top-level folder) that already exists under the app's source dir from " +
      "a pre-dataDir install is updated in place. Path traversal outside " +
      "either root is rejected.",
    {
      appId: z.string(),
      path: z.string().describe("App-relative path under the app's data dir."),
      content: z.unknown().describe("JSON value for `.json` paths, or `{ text }` / string for others."),
    },
    async input => {
      const installed = appRegistry.getApp(input.appId)
      if (!installed) return errorResult(`app_data_write: no installed app "${input.appId}".`)
      let target: string
      try {
        const roots = await resolveAppDataRoots(installed, { ensureDataDir: true })
        target = (await locateAppDataPath(roots, input.path)).target
      } catch (err) {
        return errorResult(`app_data_write: ${err instanceof Error ? err.message : String(err)}`)
      }
      let payload: string
      if (input.path.endsWith(".json")) {
        payload = JSON.stringify(input.content, null, 2)
      } else {
        const raw = input.content
        if (typeof raw === "string") payload = raw
        else if (
          raw !== null &&
          typeof raw === "object" &&
          typeof (raw as { text?: unknown }).text === "string"
        ) {
          payload = (raw as { text: string }).text
        } else {
          payload = JSON.stringify(raw)
        }
      }
      try {
        await atomicWrite(target, payload)
        return textResult({ appId: input.appId, path: input.path, size: Buffer.byteLength(payload, "utf8") })
      } catch (err) {
        return errorResult(`app_data_write: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  )

  server.tool(
    "app_data_list",
    "List entries (name + type + size) under an app-relative directory " +
      "(default `.`, the app's data dir). A missing directory returns empty " +
      "entries, not an error. When the same directory also exists under the " +
      "app's source dir (a pre-dataDir install) both views are merged, data " +
      "dir entries winning on name clashes; `.` lists the data dir only " +
      "(or the source dir while no data dir exists yet). Path traversal " +
      "outside either root is rejected.",
    {
      appId: z.string(),
      dir: z.string().optional().describe("App-relative directory to list. Defaults to `.`."),
      ...pageParamsShape,
    },
    async input => {
      const installed = appRegistry.getApp(input.appId)
      if (!installed) return errorResult(`app_data_list: no installed app "${input.appId}".`)
      const relDir = input.dir ?? "."
      const dirs: string[] = []
      try {
        const roots = await resolveAppDataRoots(installed)
        const located = await locateAppDataPath(roots, relDir)
        const isRoot = located.target === roots.dataRoot || located.target === roots.legacyRoot
        dirs.push(located.target)
        if (!isRoot && located.sibling !== undefined) dirs.push(located.sibling)
      } catch (err) {
        return errorResult(`app_data_list: ${err instanceof Error ? err.message : String(err)}`)
      }
      const seen = new Map<string, { name: string; type: "file" | "directory"; size: number }>()
      for (const target of dirs) {
        let dirents: { name: string; isDirectory(): boolean }[]
        try {
          dirents = await readdir(target, { withFileTypes: true })
        } catch {
          continue
        }
        for (const d of dirents) {
          if (seen.has(d.name)) continue
          const isDirectory = d.isDirectory()
          let size = 0
          if (!isDirectory) {
            try {
              size = (await stat(join(target, d.name))).size
            } catch {
              size = 0
            }
          }
          seen.set(d.name, { name: d.name, type: isDirectory ? "directory" : "file", size })
        }
      }
      const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
      // Pagination LAST — after the merge + sort. Without limit/cursor the
      // output is byte-identical to the pre-pagination handler.
      if (input.limit !== undefined || input.cursor !== undefined) {
        const page = paginate(entries, input, { maxLimit: 200, keyOf: e => e.name })
        return { content: [{ type: "text", text: toolText(page) }] }
      }
      return textResult({ appId: input.appId, dir: relDir, entries })
    },
  )

  server.tool(
    "app_data_migrate",
    "One-time import of legacy job-app data into the durable shape under the " +
      "app's data dir: `jobs/<jobId>.json` (normalized id/jobId/applyUrl), " +
      "`rankings/latest.json` (full ranked list) + per-job ranking " +
      "artifacts, `applications/<jobId>/{job.json,cv.json,cover.md}` from " +
      "matching `dossiers/*` folders, and `state.json`. The legacy inputs " +
      "(`ranked-jobs.json`, `dossiers/`) are read from wherever they resolve " +
      "— the app's source dir for pre-dataDir installs. Idempotent — " +
      "re-running after migration returns `alreadyMigrated` unless `force`.",
    {
      appId: z.string(),
      force: z.boolean().optional().describe("Re-run even if already migrated."),
    },
    async input => {
      const installed = appRegistry.getApp(input.appId)
      if (!installed) return errorResult(`app_data_migrate: no installed app "${input.appId}".`)
      let roots: AppDataRoots
      try {
        roots = await resolveAppDataRoots(installed, { ensureDataDir: true })
      } catch (err) {
        return errorResult(`app_data_migrate: ${err instanceof Error ? err.message : String(err)}`)
      }
      const at = async (rel: string): Promise<string> => (await locateAppDataPath(roots, rel)).target

      const stateRel = "state.json"
      if (!input.force && (await readJsonMaybe(await at(stateRel))) !== undefined) {
        return textResult({ appId: input.appId, migrated: false, alreadyMigrated: true })
      }

      let jobs: LegacyRankedJob[] = []
      const rankedRaw = await readJsonMaybe(await at("ranked-jobs.json"))
      if (Array.isArray(rankedRaw)) jobs = rankedRaw as LegacyRankedJob[]

      const normalized = jobs
        .map(normalizeJob)
        .filter(j => typeof j.jobId === "string" && (j.jobId as string).length > 0)

      for (const job of normalized) {
        const id = job.jobId as string
        await writeJson(roots, `jobs/${id}.json`, job)
        await writeJson(roots, `rankings/${id}.json`, job)
      }
      await writeJson(roots, "rankings/latest.json", normalized)

      let folderNames: string[] = []
      try {
        folderNames = (await readdir(await at("dossiers"), { withFileTypes: true }))
          .filter(e => e.isDirectory())
          .map(e => e.name)
      } catch {
        folderNames = []
      }

      const matched = new Set<string>()
      const skippedFolders: string[] = []
      for (const name of folderNames) {
        const dossierDir = await at(join("dossiers", name))
        const jobId = await readDossierJobId(dossierDir)
        const targetJob = normalized.find(j => j.jobId === jobId)
        if (!jobId || !targetJob) {
          skippedFolders.push(name)
          continue
        }
        matched.add(jobId)
        await writeJson(roots, `applications/${jobId}/job.json`, targetJob)
        const cv = await readJsonMaybe(join(dossierDir, "cv.json"))
        if (cv !== undefined) await writeJson(roots, `applications/${jobId}/cv.json`, cv)
        const cover = await readTextMaybe(join(dossierDir, "cover.md"))
        if (cover !== undefined) await writeRaw(roots, `applications/${jobId}/cover.md`, cover)
      }

      const jobCount = normalized.length
      const dossierCount = matched.size
      await writeJson(roots, stateRel, {
        migratedAt: new Date().toISOString(),
        jobCount,
        dossierCount,
        skippedFolders,
      })

      return textResult({ appId: input.appId, migrated: true, jobCount, dossierCount, skippedFolders })
    },
  )

  // --- App state ledger (app-state.ts) -------------------------------------
  // `app_state_append` is NOT auto-granted to app agents: the /mcp factory
  // (index.ts) strips this name from any request carrying
  // `?callerSessionId=` — i.e. every daemon-spawned agent session — via the
  // same withToolExclusion plumbing as the role denyTools gate. The daemon
  // runner and UI actions (no caller session id) keep it. Reads are open.

  server.tool(
    APP_STATE_APPEND_TOOL_NAME,
    "Append one event to an installed app's append-only state ledger " +
      "(`<dataDir>/state/events.jsonl`). The envelope is zod-validated, " +
      "including the per-kind payload (gate-report needs `{ok, exitCode}`, " +
      "approval needs `{approved, who}`, blocked needs `{reason}`); `id` and " +
      "`ts` are daemon-assigned. Writes are single-line O_APPEND appends — " +
      "concurrent appends never interleave. This is the daemon-owned state " +
      "plane: agents cannot call it (stripped from agent sessions at the " +
      "gateway), it is for the daemon runner and explicit UI actions — do " +
      "NOT list it in an app's `ui.tools` unless a human approval action " +
      "genuinely needs it.",
    {
      appId: z.string(),
      event: appStateEventInputSchema.describe(
        "Event envelope: { appRunId?, stage, item?, kind, by, payload }.",
      ),
    },
    async input => {
      const installed = appRegistry.getApp(input.appId)
      if (!installed) return errorResult(`app_state_append: no installed app "${input.appId}".`)
      try {
        const stored = await appendAppStateEvent(installed, input.event as never)
        return textResult({ appId: input.appId, event: stored })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err))
      }
    },
  )

  server.tool(
    "app_state_get",
    "Read an installed app's state ledger: the folded stage snapshot " +
      "(`foldAppStateEvents` — see app-state.ts for the reducer) plus the " +
      "last `tail` events (default 20). A missing ledger returns an empty " +
      "snapshot, not an error.",
    {
      appId: z.string(),
      tail: z.number().int().positive().optional().describe("How many trailing events to include. Default 20."),
    },
    async input => {
      const installed = appRegistry.getApp(input.appId)
      if (!installed) return errorResult(`app_state_get: no installed app "${input.appId}".`)
      const { events, malformedLines } = await readAppStateEvents(installed)
      const snapshot = await appStateSnapshot(installed)
      const tail = input.tail ?? 20
      return textResult({
        appId: input.appId,
        snapshot,
        events: events.slice(-tail),
        ...(malformedLines > 0 ? { malformedLines } : {}),
      })
    },
  )

  server.tool(
    "app_state_list",
    "List events from an installed app's state ledger in append order, " +
      "optionally filtered by `stage`, `item`, `kinds`, and/or `since` (ISO " +
      "timestamp — events at or after it), capped at `limit` (default 100).",
    {
      appId: z.string(),
      stage: z.string().optional(),
      item: z.string().optional(),
      kinds: z.array(z.enum(APP_STATE_KINDS)).optional(),
      since: z.string().optional().describe("ISO timestamp lower bound (inclusive)."),
      limit: z.number().int().positive().optional().describe("Max events returned. Default 100."),
    },
    async input => {
      const installed = appRegistry.getApp(input.appId)
      if (!installed) return errorResult(`app_state_list: no installed app "${input.appId}".`)
      const { events, malformedLines } = await readAppStateEvents(installed)
      const kinds = input.kinds !== undefined ? new Set<string>(input.kinds) : undefined
      const filtered: AppStateEvent[] = []
      const limit = input.limit ?? 100
      for (const e of events) {
        if (input.stage !== undefined && e.stage !== input.stage) continue
        if (input.item !== undefined && e.item !== input.item) continue
        if (kinds !== undefined && !kinds.has(e.kind)) continue
        if (input.since !== undefined && e.ts < input.since) continue
        filtered.push(e)
        if (filtered.length >= limit) break
      }
      return textResult({
        appId: input.appId,
        events: filtered,
        total: events.length,
        ...(malformedLines > 0 ? { malformedLines } : {}),
      })
    },
  )
}
