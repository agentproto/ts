/**
 * App catalog — a static, hand-curated `~/.agentproto/app-catalog.json`
 * listing apps a user could `app_install`, independent of whether any are
 * installed yet, plus optional remote catalog `sources` (each an HTTP URL
 * returning `{ entries: AppCatalogEntry[] }`). Read-only from the daemon's
 * side; `app_catalog` (app-tools.ts) merges local entries, remote entries and
 * `AppRegistry.listApps()` to report installed/hasUi status.
 *
 * Sources (see `resolveCatalogSources`): the default public catalog
 * (`DEFAULT_CATALOG_SOURCE_URL`, config `catalog.defaultSource`) comes
 * first, then config `catalog.sources` — which win over (replace) `sources`
 * in the catalog file when set. Extra sources ADD to the default one. Remote
 * catalogs follow the `app-catalog/v1` format; the last good copy of each is
 * cached on disk so `app_catalog` keeps working offline.
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AppSource } from "./app-registry.js"

export type { AppSource }

export type AppPlacement = "local" | "box" | "any" | "split"

export type AppCatalogTier = "git" | "bundle" | "hosted"

export interface AppCatalogLicense {
  kind: "free" | "paid" | "private"
  url?: string
}

export interface AppCatalogRequires {
  browser?: boolean
  fs?: boolean
  secrets?: string[]
}

/** Remote catalog entry (`app-catalog/v1`). `source` lets a store call
 *  `app_install {url, ref, subdir, sha}` (git) or `app_install {url, sha256}`
 *  (`.agentapp`). Every field but `appId` + `source` is optional, so
 *  pre-v1 catalogs (`{ entries }` only) keep validating. */
export interface AppCatalogEntry {
  appId: string
  name?: string
  description?: string
  category?: string
  source: AppSource
  placement?: AppPlacement
  icon?: string
  version?: string
  tier?: AppCatalogTier
  publisher?: string
  license?: AppCatalogLicense
  minAgentprotoVersion?: string
  requires?: AppCatalogRequires
  featured?: boolean
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
    size: z.number().int().nonnegative().optional(),
  }),
])

export const AppCatalogEntrySchema: z.ZodType<AppCatalogEntry> = z.object({
  appId: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  source: AppSourceSchema,
  placement: z.enum(["local", "box", "any", "split"]).optional(),
  icon: z.string().optional(),
  version: z.string().optional(),
  tier: z.enum(["git", "bundle", "hosted"]).optional(),
  publisher: z.string().optional(),
  license: z
    .object({ kind: z.enum(["free", "paid", "private"]), url: z.string().optional() })
    .optional(),
  minAgentprotoVersion: z.string().optional(),
  requires: z
    .object({
      browser: z.boolean().optional(),
      fs: z.boolean().optional(),
      secrets: z.array(z.string()).optional(),
    })
    .optional(),
  featured: z.boolean().optional(),
})

/** `schema` tag of a v1 catalog document. */
export const CATALOG_SCHEMA_V1 = "app-catalog/v1"

const RemoteCatalogSchema = z.object({
  schema: z.string().optional(),
  generatedAt: z.string().optional(),
  entries: z.array(z.unknown()),
})

/**
 * Default public catalog, queried by `app_catalog` unless config
 * `catalog.defaultSource` is `false` (a URL string replaces it).
 * PLACEHOLDER: where catalogs and bundles are hosted is not decided yet
 * (store plan §6, question 1) — this URL may not serve a catalog today. A
 * failing default source is never fatal: `app_catalog` falls back to the
 * last good copy cached on disk, then to the embedded first-party list
 * (`first-party-catalog.ts`).
 */
export const DEFAULT_CATALOG_SOURCE_URL = "https://cli.agentproto.sh/catalog/v1/apps.json"

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

export type CatalogSourceOrigin = "default" | "config" | "file"

export interface ResolvedCatalogSource extends AppCatalogSource {
  readonly origin: CatalogSourceOrigin
}

/**
 * Remote sources `app_catalog` queries, in precedence order (first wins on
 * an `appId` collision): the default source (unless `defaultSource: false`;
 * a non-empty string replaces its URL), then config `catalog.sources` when
 * set (even empty), else the catalog file's `sources`. Config/file sources
 * ADD to the default one, they never replace it. Duplicate URLs are dropped.
 */
export function resolveCatalogSources(
  fileSources: readonly AppCatalogSource[] | undefined,
  config: { sources?: unknown; defaultSource?: unknown } | undefined,
): ResolvedCatalogSource[] {
  const out: ResolvedCatalogSource[] = []
  const seen = new Set<string>()
  const push = (url: string, origin: CatalogSourceOrigin): void => {
    if (seen.has(url)) return
    seen.add(url)
    out.push({ url, origin })
  }
  const def = config?.defaultSource
  if (def !== false) {
    push(typeof def === "string" && def.length > 0 ? def : DEFAULT_CATALOG_SOURCE_URL, "default")
  }
  if (Array.isArray(config?.sources)) {
    for (const s of parseSources(config.sources)) push(s.url, "config")
  } else {
    for (const s of fileSources ?? []) push(s.url, "file")
  }
  return out
}

/** One source's outcome, in the order sources were passed. */
export interface CatalogSourceResult {
  url: string
  entries: AppCatalogEntry[]
  /** True when `entries` come from the disk cache because the live fetch failed. */
  stale: boolean
  /** When the entries were fetched (live or cached), ISO-8601. */
  fetchedAt?: string
  /** False when the source yielded nothing at all (fetch failed, no cache). */
  ok: boolean
}

export interface RemoteCatalogResult {
  entries: AppCatalogEntry[]
  warnings: string[]
  bySource: CatalogSourceResult[]
}

export interface RemoteCatalogClientOptions {
  /** Default 5 minutes. */
  ttlMs?: number
  /** Per-source request timeout. Default 5000. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
  /** Directory for the last-good copy of each source (`<sha1(url)>.json`).
   *  Absent = no disk cache (in-memory TTL cache only). */
  cacheDir?: string
}

export interface RemoteCatalogClient {
  /** Fetch + validate every source (in order, in parallel). A failing source
   *  never throws: it yields a `warnings` line and either its last cached
   *  copy (`stale`) or no entries. Live results are cached per URL in memory
   *  for `ttlMs` and on disk (when `cacheDir` is set); `refresh` bypasses the
   *  in-memory cache. */
  fetchSources(
    sources: readonly AppCatalogSource[],
    opts?: { refresh?: boolean },
  ): Promise<RemoteCatalogResult>
}

export const DEFAULT_REMOTE_CATALOG_TTL_MS = 5 * 60_000
export const DEFAULT_REMOTE_CATALOG_TIMEOUT_MS = 5_000

/** Disk-cache file for `url` under `cacheDir`. */
export function catalogCachePath(cacheDir: string, url: string): string {
  return join(cacheDir, `${createHash("sha1").update(url).digest("hex")}.json`)
}

interface CatalogDiskCache {
  url: string
  fetchedAt: string
  entries: unknown[]
}

type SourceFetch = CatalogSourceResult & { warnings: string[] }

export function createRemoteCatalogClient(
  options: RemoteCatalogClientOptions = {},
): RemoteCatalogClient {
  const ttlMs = options.ttlMs ?? DEFAULT_REMOTE_CATALOG_TTL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_CATALOG_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const cacheDir = options.cacheDir
  const cache = new Map<string, { at: number; result: SourceFetch }>()

  async function readDiskCache(url: string): Promise<{ entries: AppCatalogEntry[]; fetchedAt: string } | undefined> {
    if (cacheDir === undefined) return undefined
    try {
      const raw = JSON.parse(await readFile(catalogCachePath(cacheDir, url), "utf8")) as Partial<CatalogDiskCache>
      if (raw.url !== url || !Array.isArray(raw.entries) || typeof raw.fetchedAt !== "string") return undefined
      const entries: AppCatalogEntry[] = []
      for (const e of raw.entries) {
        const parsed = AppCatalogEntrySchema.safeParse(e)
        if (parsed.success) entries.push(parsed.data)
      }
      return { entries, fetchedAt: raw.fetchedAt }
    } catch {
      return undefined
    }
  }

  async function writeDiskCache(url: string, entries: AppCatalogEntry[], fetchedAt: string): Promise<void> {
    if (cacheDir === undefined) return
    try {
      await mkdir(cacheDir, { recursive: true })
      const file = catalogCachePath(cacheDir, url)
      const tmp = `${file}.tmp-${process.pid}`
      const body: CatalogDiskCache = { url, fetchedAt, entries }
      await writeFile(tmp, JSON.stringify(body, null, 2) + "\n", "utf8")
      await rename(tmp, file)
    } catch {
      // Best-effort — a cache write failure must not fail the listing.
    }
  }

  async function failed(url: string, warning: string): Promise<SourceFetch> {
    const cached = await readDiskCache(url)
    if (cached === undefined) return { url, entries: [], warnings: [warning], stale: false, ok: false }
    return {
      url,
      entries: cached.entries,
      warnings: [`${warning}; using the copy cached at ${cached.fetchedAt}`],
      stale: true,
      fetchedAt: cached.fetchedAt,
      ok: true,
    }
  }

  async function fetchOne(url: string): Promise<SourceFetch> {
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
      return failed(url, `catalog source ${url}: ${reason}`)
    }
    const shape = RemoteCatalogSchema.safeParse(body)
    if (!shape.success) {
      return failed(url, `catalog source ${url}: expected { entries: [...] }`)
    }
    const entries: AppCatalogEntry[] = []
    const warnings: string[] = []
    if (shape.data.schema !== undefined && shape.data.schema !== CATALOG_SCHEMA_V1) {
      warnings.push(
        `catalog source ${url}: unknown schema "${shape.data.schema}" — reading its entries as ${CATALOG_SCHEMA_V1}`,
      )
    }
    shape.data.entries.forEach((raw, i) => {
      const parsed = AppCatalogEntrySchema.safeParse(raw)
      if (parsed.success) entries.push(parsed.data)
      else warnings.push(`catalog source ${url}: entries[${i}] invalid (${parsed.error.issues[0]?.message ?? "schema mismatch"})`)
    })
    const fetchedAt = new Date(now()).toISOString()
    await writeDiskCache(url, entries, fetchedAt)
    return { url, entries, warnings, stale: false, fetchedAt, ok: true }
  }

  return {
    async fetchSources(sources, opts = {}) {
      const results = await Promise.all(
        sources.map(async ({ url }) => {
          const hit = cache.get(url)
          if (!opts.refresh && hit && now() - hit.at < ttlMs) return hit.result
          const result = await fetchOne(url)
          // Neither failures nor stale disk fallbacks are cached in memory,
          // so a flaky source retries on the next call.
          if (!result.stale && (result.entries.length > 0 || result.warnings.length === 0)) {
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
        bySource: results.map(({ warnings: _warnings, ...rest }) => rest),
      }
    },
  }
}
