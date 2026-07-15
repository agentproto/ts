/**
 * Reviewed refresh workflow for catalog-sync.
 *
 * Extends the existing generator framework with explicit, reviewable diffs and
 * source-level metadata so operators can see exactly what changed and why.
 *
 * Design constraints (per project convention):
 *   - Pricing is never fabricated.
 *   - Refresh only hits pinned source URLs; unrefreshable sources are skipped
 *     with an explanation.
 *   - The committed snapshot is the single source of truth for offline runs.
 *   - Availability-only local cache stays separate from the reviewed refresh.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type {
  CatalogGenerator,
  CatalogSource,
  GeneratedFiles,
  GeneratorContext,
} from "./types.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

function catalogSyncDir(): string {
  return resolve(__dirname, "..")
}

function snapshotPath(id: string): string {
  return join(catalogSyncDir(), "snapshots", `${id}.json`)
}

function repoRoot(): string {
  let dir = catalogSyncDir()
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirname(dirname(catalogSyncDir()))
}

function readIfExists(absPath: string): string | undefined {
  if (!existsSync(absPath)) return undefined
  return readFileSync(absPath, "utf8")
}

function resolveHeaders(headers?: Record<string, string>): {
  headers: Record<string, string>
  missing: string[]
} {
  const out: Record<string, string> = {}
  const missing: string[] = []
  if (!headers) return { headers: out, missing }
  for (const [key, value] of Object.entries(headers)) {
    out[key] = value.replace(/env:([A-Z0-9_]+)/g, (_match, name: string) => {
      const v = process.env[name]
      if (v === undefined || v === "") {
        missing.push(name)
        return ""
      }
      return v
    })
  }
  return { headers: out, missing }
}

// ── Source metadata ────────────────────────────────────────────────────────

/**
 * Source-level refresh metadata. Wraps a frozen {@link CatalogSource} without
 * mutating it, so existing generators keep compiling unchanged.
 */
export interface RefreshableSource {
  source: CatalogSource
  /** When false, the source is skipped by --refresh and documented in results. */
  refreshable: boolean
  /** Human-readable explanation of the source contract or gap. */
  notes?: string
}

export interface SourceRefreshResult {
  id: string
  url: string
  /** True when a live fetch was attempted and succeeded. */
  refreshed: boolean
  /** True when the source is known to be unrefreshable. */
  skipped?: boolean
  /** Human-readable status / gap explanation. */
  notes?: string
  /** Present when refresh was attempted but failed. */
  error?: string
}

// ── File diff ──────────────────────────────────────────────────────────────

export interface CatalogFileDiff {
  /** Repo-relative path. */
  path: string
  /** Content currently on disk, or undefined when the file does not exist. */
  before: string | undefined
  /** Generated content. */
  after: string
  /** True when before !== after. */
  changed: boolean
}

// ── Options / result ───────────────────────────────────────────────────────

export interface ReviewedRefreshOptions {
  /** When true, attempt live fetches for refreshable sources. */
  refresh: boolean
  /** When true, write generated files to disk. */
  write: boolean
  /**
   * Optional fetch implementation for tests. Defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch
}

export interface ReviewedRefreshResult {
  /** Generated repo-relative path → content. */
  files: GeneratedFiles
  /** Repo-relative paths whose generated content differs from disk. */
  changed: string[]
  /** Per-file before/after reviewable diffs. */
  diffs: CatalogFileDiff[]
  /** Per-source refresh status. */
  sources: SourceRefreshResult[]
}

// ── Implementation ─────────────────────────────────────────────────────────

/**
 * Fetch every refreshable source and record the outcome.
 *
 * Unrefreshable sources (e.g. OpenAI, which has no stable pricing endpoint)
 * are reported as skipped rather than silently ignored or scraped.
 */
export async function refreshSources(
  sources: RefreshableSource[],
  opts: Pick<ReviewedRefreshOptions, "refresh" | "fetchImpl">
): Promise<SourceRefreshResult[]> {
  const results: SourceRefreshResult[] = []
  const fetchImpl = opts.fetchImpl ?? fetch

  for (const { source, refreshable, notes } of sources) {
    if (!opts.refresh) {
      results.push({
        id: source.id,
        url: source.url,
        refreshed: false,
        notes: "Offline mode: using committed snapshot.",
      })
      continue
    }

    if (!refreshable) {
      results.push({
        id: source.id,
        url: source.url,
        refreshed: false,
        skipped: true,
        notes: notes ?? "Source is not refreshable.",
      })
      continue
    }

    const { headers, missing } = resolveHeaders(source.headers)
    if (missing.length > 0) {
      results.push({
        id: source.id,
        url: source.url,
        refreshed: false,
        error: `Missing env vars: ${missing.join(", ")}`,
      })
      continue
    }

    try {
      const res = await fetchImpl(source.url, {
        method: source.method ?? "GET",
        headers,
        ...(source.body !== undefined
          ? { body: JSON.stringify(source.body) }
          : {}),
      })
      if (!res.ok) {
        results.push({
          id: source.id,
          url: source.url,
          refreshed: false,
          error: `${res.status} ${res.statusText}`,
        })
        continue
      }
      const text = await res.text()
      const parsed: unknown = JSON.parse(text)
      mkdirSync(dirname(snapshotPath(source.id)), { recursive: true })
      writeFileSync(
        snapshotPath(source.id),
        `${JSON.stringify(parsed, null, 2)}\n`,
        "utf8"
      )
      results.push({
        id: source.id,
        url: source.url,
        refreshed: true,
        notes: "Snapshot updated from live source.",
      })
    } catch (err) {
      results.push({
        id: source.id,
        url: source.url,
        refreshed: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return results
}

/**
 * Run generators using the current snapshots (whether refreshed or committed)
 * and produce reviewable file diffs.
 */
export async function reviewedRefresh(
  gens: CatalogGenerator[],
  refreshableSources: RefreshableSource[],
  opts: ReviewedRefreshOptions
): Promise<ReviewedRefreshResult> {
  const sourceResults = await refreshSources(refreshableSources, opts)

  const files: GeneratedFiles = {}
  for (const gen of gens) {
    const ctx: GeneratorContext = {
      refresh: opts.refresh,
      async fetchSource(src: CatalogSource): Promise<unknown> {
        const path = snapshotPath(src.id)
        const existing = readIfExists(path)
        if (existing !== undefined) return JSON.parse(existing)
        throw new Error(
          `catalog-sync: no committed snapshot for source "${src.id}" (${path}).`
        )
      },
    }
    const out = await gen.generate(ctx)
    Object.assign(files, out)
  }

  const root = repoRoot()
  const diffs: CatalogFileDiff[] = []
  const changed: string[] = []

  for (const [relPath, after] of Object.entries(files)) {
    const abs = join(root, relPath)
    const before = readIfExists(abs)
    const isChanged = before !== after
    diffs.push({ path: relPath, before, after, changed: isChanged })
    if (isChanged) {
      changed.push(relPath)
      if (opts.write) {
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, after, "utf8")
      }
    }
  }

  return { files, changed, diffs, sources: sourceResults }
}
