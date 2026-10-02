/**
 * App catalog — a static, hand-curated `~/.agentproto/app-catalog.json`
 * listing apps a user could `app_install`, independent of whether any are
 * installed yet, plus optional remote catalog `sources` (each an HTTP URL
 * returning `{ entries: AppCatalogEntry[] }`). Read-only from the daemon's
 * side; `app_catalog` (app-tools.ts) merges local entries, remote entries and
 * `AppRegistry.listApps()` to report installed/hasUi status.
 *
 * Source precedence: config `catalog.sources` wins over `sources` in the
 * catalog file when both are set (no merge of the two lists).
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AppSource } from "./app-registry.js"

export type { AppSource }

export type AppPlacement = "local" | "box" | "any" | "split"

/** Remote catalog entry (PLAN §1.4). `source` lets a store call
 *  `app_install {url, ref, subdir}` (git) or `app_install {url}` (`.agentapp`). */
export interface AppCatalogEntry {
  appId: string
  name?: string
  description?: string
  category?: string
  source: AppSource
  placement?: AppPlacement
}

/** Entry of the local `app-catalog.json` `apps` array: a directory on disk. */
export interface AppCatalogFileEntry {
  readonly appId: string
  readonly name?: string
  readonly description?: string
  readonly dir: string
  readonly category?: string
}

export interface AppCatalogSource {
  readonly url: string
}

export interface AppCatalogFile {
  readonly apps: readonly AppCatalogFileEntry[]
  readonly sources?: readonly AppCatalogSource[]
}

const AppSourceSchema: z.ZodType<AppSource> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }),
  z.object({
    kind: z.literal("git"),
    url: z.string().min(1),
    ref: z.string().optional(),
    sha: z.string().min(1),
    subdir: z.string().optional(),
  }),
  z.object({
    kind: z.literal("agentapp"),
    url: z.string().min(1),
    sha256: z.string().min(1),
    version: z.string().min(1),
  }),
])

export const AppCatalogEntrySchema: z.ZodType<AppCatalogEntry> = z.object({
  appId: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  source: AppSourceSchema,
  placement: z.enum(["local", "box", "any", "split"]).optional(),
})

const RemoteCatalogSchema = z.object({ entries: z.array(z.unknown()) })

const EMPTY_CATALOG: AppCatalogFile = { apps: [] }

export function defaultAppCatalogPath(): string {
  return join(homedir(), ".agentproto", "app-catalog.json")
}

/**
 * Read + parse the catalog file at `path` (default `~/.agentproto/app-catalog.json`).
 * Tolerates a missing file (returns an empty catalog) and a malformed one
 * (unreadable JSON, non-array `apps`, entries missing `appId`/`dir`, and
 * `sources` without a string `url` are dropped) — never throws.
 */
export async function loadAppCatalogFile(path?: string): Promise<AppCatalogFile> {
  const catalogPath = path ?? defaultAppCatalogPath()
  let raw: string
  try {
    raw = await readFile(catalogPath, "utf8")
  } catch {
    return EMPTY_CATALOG
  }
  try {
    const parsed = JSON.parse(raw) as { apps?: unknown; sources?: unknown }
    const sources = parseSources(parsed.sources)
    const apps = Array.isArray(parsed.apps)
      ? parsed.apps.filter((e): e is AppCatalogFileEntry => {
          if (typeof e !== "object" || e === null) return false
          const rec = e as Record<string, unknown>
          return typeof rec.appId === "string" && typeof rec.dir === "string"
        })
      : []
    return sources.length > 0 ? { apps, sources } : { apps }
  } catch {
    return EMPTY_CATALOG
  }
}

function parseSources(raw: unknown): AppCatalogSource[] {
  if (!Array.isArray(raw)) return []
  const out: AppCatalogSource[] = []
  for (const s of raw) {
    if (typeof s !== "object" || s === null) continue
    const url = (s as Record<string, unknown>).url
    if (typeof url === "string" && url.length > 0) out.push({ url })
  }
  return out
}

/** Config `catalog.sources` when set (even empty), else the catalog file's. */
export function resolveCatalogSources(
  fileSources: readonly AppCatalogSource[] | undefined,
  configSources: unknown,
): AppCatalogSource[] {
  if (Array.isArray(configSources)) return parseSources(configSources)
  return [...(fileSources ?? [])]
}

export interface RemoteCatalogResult {
  entries: AppCatalogEntry[]
  warnings: string[]
}

export interface RemoteCatalogClientOptions {
  /** Default 5 minutes. */
  ttlMs?: number
  /** Per-source request timeout. Default 5000. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

export interface RemoteCatalogClient {
  /** Fetch + validate every source (in order, in parallel). A failing source
   *  never throws: it yields a `warnings` line and contributes no entries.
   *  Successful results are cached per URL for `ttlMs`; `refresh` bypasses. */
  fetchSources(
    sources: readonly AppCatalogSource[],
    opts?: { refresh?: boolean },
  ): Promise<RemoteCatalogResult>
}

export const DEFAULT_REMOTE_CATALOG_TTL_MS = 5 * 60_000
export const DEFAULT_REMOTE_CATALOG_TIMEOUT_MS = 5_000

export function createRemoteCatalogClient(
  options: RemoteCatalogClientOptions = {},
): RemoteCatalogClient {
  const ttlMs = options.ttlMs ?? DEFAULT_REMOTE_CATALOG_TTL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_CATALOG_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const cache = new Map<string, { at: number; result: RemoteCatalogResult }>()

  async function fetchOne(url: string): Promise<RemoteCatalogResult> {
    let body: unknown
    try {
      const res = await fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      body = await res.json()
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
      const reason = timedOut
        ? `timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err)
      return { entries: [], warnings: [`catalog source ${url}: ${reason}`] }
    }
    const shape = RemoteCatalogSchema.safeParse(body)
    if (!shape.success) {
      return { entries: [], warnings: [`catalog source ${url}: expected { entries: [...] }`] }
    }
    const entries: AppCatalogEntry[] = []
    const warnings: string[] = []
    shape.data.entries.forEach((raw, i) => {
      const parsed = AppCatalogEntrySchema.safeParse(raw)
      if (parsed.success) entries.push(parsed.data)
      else warnings.push(`catalog source ${url}: entries[${i}] invalid (${parsed.error.issues[0]?.message ?? "schema mismatch"})`)
    })
    return { entries, warnings }
  }

  return {
    async fetchSources(sources, opts = {}) {
      const results = await Promise.all(
        sources.map(async ({ url }) => {
          const hit = cache.get(url)
          if (!opts.refresh && hit && now() - hit.at < ttlMs) return hit.result
          const result = await fetchOne(url)
          // Failures are not cached so a flaky source retries on the next call.
          if (result.entries.length > 0 || result.warnings.length === 0) {
            cache.set(url, { at: now(), result })
          } else {
            cache.delete(url)
          }
          return result
        }),
      )
      return {
        entries: results.flatMap(r => r.entries),
        warnings: results.flatMap(r => r.warnings),
      }
    },
  }
}
