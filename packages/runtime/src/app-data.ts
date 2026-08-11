/**
 * App-scoped durable data plane — path-traversal-guarded read/write/list
 * tools anchored under an installed app's own `dir` (see `AppRegistry`),
 * plus a one-time migration of legacy job-app data into the durable shape.
 *
 * Tools:
 *   app_data_read     read a file (JSON-parsed when it ends in `.json`)
 *   app_data_write    atomic write, JSON-stringified for `.json` paths
 *   app_data_list     list entries under an app-relative dir
 *   app_data_migrate  import legacy `ranked-jobs.json` + `dossiers/*` data
 *
 * Unlike the generic fs-tools (workspace-rooted), everything here resolves
 * strictly under the app's `dir` and refuses to escape it.
 */

import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { AppRegistry } from "./app-registry.js"

/** Thrown when a relative app path resolves outside the app's own directory. */
export class AppPathTraversalError extends Error {
  readonly code = "APP_PATH_TRAVERSAL"
  constructor(relPath: string) {
    super(`app-data: path traversal rejected for "${relPath}" — must resolve inside the app dir.`)
    this.name = "AppPathTraversalError"
  }
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

function textResult(body: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] }
}

function errorResult(text: string): {
  content: { type: "text"; text: string }[]
  isError: true
} {
  return { content: [{ type: "text", text: JSON.stringify({ error: text }) }], isError: true }
}

/** Realpath-normalize the app root once so relative segments can never climb
 *  out through a symlinked app dir. Undefined when the dir is gone. */
async function safeRoot(appDir: string): Promise<string | undefined> {
  try {
    return await realpath(appDir)
  } catch {
    return undefined
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

async function atomicWrite(filePath: string, data: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}`
  await writeFile(tmp, data, "utf8")
  await rename(tmp, filePath)
}

async function writeRaw(root: string, rel: string, data: string): Promise<void> {
  await atomicWrite(resolveAppDataPath(root, rel), data)
}

async function writeJson(root: string, rel: string, value: unknown): Promise<void> {
  await writeRaw(root, rel, JSON.stringify(value, null, 2) + "\n")
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
      "parsed value in `content`; everything else returns the raw text. Path " +
      "traversal outside the app dir is rejected.",
    { appId: z.string(), path: z.string().describe("App-relative path under the app's own dir.") },
    async input => {
      const installed = appRegistry.getApp(input.appId)
      if (!installed) return errorResult(`app_data_read: no installed app "${input.appId}".`)
      const root = await safeRoot(installed.dir)
      if (!root) return errorResult(`app_data_read: app dir "${installed.dir}" is not accessible.`)
      let target: string
      try {
        target = resolveAppDataPath(root, input.path)
        await assertRealInside(root, target)
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
      "string `content`). Atomic write (tmp + rename). Path traversal outside " +
      "the app dir is rejected.",
    {
      appId: z.string(),
      path: z.string().describe("App-relative path under the app's own dir."),
      content: z.unknown().describe("JSON value for `.json` paths, or `{ text }` / string for others."),
    },
    async input => {
      const installed = appRegistry.getApp(input.appId)
      if (!installed) return errorResult(`app_data_write: no installed app "${input.appId}".`)
      const root = await safeRoot(installed.dir)
      if (!root) return errorResult(`app_data_write: app dir "${installed.dir}" is not accessible.`)
      let target: string
      try {
        target = resolveAppDataPath(root, input.path)
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
      "(default `.`). A missing directory returns empty entries, not an " +
      "error. Path traversal outside the app dir is rejected.",
    {
      appId: z.string(),
      dir: z.string().optional().describe("App-relative directory to list. Defaults to `.`."),
    },
    async input => {
      const installed = appRegistry.getApp(input.appId)
      if (!installed) return errorResult(`app_data_list: no installed app "${input.appId}".`)
      const root = await safeRoot(installed.dir)
      if (!root) return errorResult(`app_data_list: app dir "${installed.dir}" is not accessible.`)
      const relDir = input.dir ?? "."
      let target: string
      try {
        target = resolveAppDataPath(root, relDir)
      } catch (err) {
        return errorResult(`app_data_list: ${err instanceof Error ? err.message : String(err)}`)
      }
      let dirents: { name: string; isDirectory(): boolean }[]
      try {
        dirents = await readdir(target, { withFileTypes: true })
      } catch {
        return textResult({ appId: input.appId, dir: relDir, entries: [] })
      }
      const entries: { name: string; type: "file" | "directory"; size: number }[] = []
      for (const d of dirents) {
        const isDirectory = d.isDirectory()
        let size = 0
        if (!isDirectory) {
          try {
            size = (await stat(join(target, d.name))).size
          } catch {
            size = 0
          }
        }
        entries.push({ name: d.name, type: isDirectory ? "directory" : "file", size })
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      return textResult({ appId: input.appId, dir: relDir, entries })
    },
  )

  server.tool(
    "app_data_migrate",
    "One-time import of legacy job-app data into the durable shape under the " +
      "app dir: `data/jobs/<jobId>.json` (normalized id/jobId/applyUrl), " +
      "`data/rankings/latest.json` (full ranked list) + per-job ranking " +
      "artifacts, `applications/<jobId>/{job.json,cv.json,cover.md}` from " +
      "matching `dossiers/*` folders, and `data/state.json`. Idempotent — " +
      "re-running after migration returns `alreadyMigrated` unless `force`.",
    {
      appId: z.string(),
      force: z.boolean().optional().describe("Re-run even if already migrated."),
    },
    async input => {
      const installed = appRegistry.getApp(input.appId)
      if (!installed) return errorResult(`app_data_migrate: no installed app "${input.appId}".`)
      const root = await safeRoot(installed.dir)
      if (!root) return errorResult(`app_data_migrate: app dir "${installed.dir}" is not accessible.`)

      const stateRel = "data/state.json"
      if (!input.force && (await readJsonMaybe(resolveAppDataPath(root, stateRel))) !== undefined) {
        return textResult({ appId: input.appId, migrated: false, alreadyMigrated: true })
      }

      let jobs: LegacyRankedJob[] = []
      const rankedRaw = await readJsonMaybe(resolveAppDataPath(root, "ranked-jobs.json"))
      if (Array.isArray(rankedRaw)) jobs = rankedRaw as LegacyRankedJob[]

      const normalized = jobs
        .map(normalizeJob)
        .filter(j => typeof j.jobId === "string" && (j.jobId as string).length > 0)

      for (const job of normalized) {
        const id = job.jobId as string
        await writeJson(root, `data/jobs/${id}.json`, job)
        await writeJson(root, `data/rankings/${id}.json`, job)
      }
      await writeJson(root, "data/rankings/latest.json", normalized)

      let folderNames: string[] = []
      try {
        folderNames = (await readdir(resolveAppDataPath(root, "dossiers"), { withFileTypes: true }))
          .filter(e => e.isDirectory())
          .map(e => e.name)
      } catch {
        folderNames = []
      }

      const matched = new Set<string>()
      const skippedFolders: string[] = []
      for (const name of folderNames) {
        const dossierDir = resolveAppDataPath(root, join("dossiers", name))
        const jobId = await readDossierJobId(dossierDir)
        const targetJob = normalized.find(j => j.jobId === jobId)
        if (!jobId || !targetJob) {
          skippedFolders.push(name)
          continue
        }
        matched.add(jobId)
        await writeJson(root, `applications/${jobId}/job.json`, targetJob)
        const cv = await readJsonMaybe(join(dossierDir, "cv.json"))
        if (cv !== undefined) await writeJson(root, `applications/${jobId}/cv.json`, cv)
        const cover = await readTextMaybe(join(dossierDir, "cover.md"))
        if (cover !== undefined) await writeRaw(root, `applications/${jobId}/cover.md`, cover)
      }

      const jobCount = normalized.length
      const dossierCount = matched.size
      await writeJson(root, stateRel, {
        migratedAt: new Date().toISOString(),
        jobCount,
        dossierCount,
        skippedFolders,
      })

      return textResult({ appId: input.appId, migrated: true, jobCount, dossierCount, skippedFolders })
    },
  )
}
