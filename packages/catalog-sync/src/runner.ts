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

/**
 * The catalog-sync package directory. Resolves the same way whether the
 * module is loaded from `src/` (vitest, type-checking) or `dist/` (built) —
 * both sit one level below the package root, so walking up one directory
 * from this file lands on `packages/catalog-sync/`.
 */
function catalogSyncDir(): string {
  return resolve(__dirname, "..")
}

/** Absolute path to a committed/pinned source snapshot. */
function snapshotPath(id: string): string {
  return join(catalogSyncDir(), "snapshots", `${id}.json`)
}

/**
 * The monorepo root. Resolved by walking up from the catalog-sync package
 * until `pnpm-workspace.yaml` is found. Generated-file paths in
 * {@link GeneratedFiles} are repo-relative and are resolved against this.
 */
function repoRoot(): string {
  let dir = catalogSyncDir()
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Fallback: catalog-sync lives at <root>/packages/catalog-sync.
  return dirname(dirname(catalogSyncDir()))
}

/** Reads an existing file as UTF-8, or returns undefined when absent. */
function readIfExists(absPath: string): string | undefined {
  if (!existsSync(absPath)) return undefined
  return readFileSync(absPath, "utf8")
}

/**
 * Resolve `env:VAR_NAME` tokens inside header values from `process.env`.
 * Returns the materialized headers plus the names of any referenced env vars
 * that are unset — the caller uses `missing` to decide whether the source can
 * be refreshed (we never fetch an authed endpoint without its key).
 */
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

export interface RunGeneratorsOptions {
  /** When true, missing snapshots are fetched from their pinned `url`. */
  refresh: boolean
  /** When true, generated files are written to disk at their repo-relative path. */
  write: boolean
}

export interface RunGeneratorsResult {
  files: GeneratedFiles
  /** Repo-relative paths whose generated content differs from what is on disk. */
  changed: string[]
}

/**
 * Runs each generator, gathering its emitted files, then (optionally) writes
 * them. `changed` is ALWAYS computed — it is the diff of generated content
 * vs disk — so `--check` (write=false) can surface drift without mutating
 * anything. Writes only happen when `write=true` AND a path differs.
 */
export async function runGenerators(
  gens: CatalogGenerator[],
  opts: RunGeneratorsOptions
): Promise<RunGeneratorsResult> {
  const files: GeneratedFiles = {}

  for (const gen of gens) {
    const ctx: GeneratorContext = {
      refresh: opts.refresh,
      async fetchSource(src: CatalogSource): Promise<unknown> {
        const path = snapshotPath(src.id)
        const existing = readIfExists(path)

        // Offline path (default): reuse the committed snapshot; error if none.
        if (!opts.refresh) {
          if (existing !== undefined) return JSON.parse(existing)
          throw new Error(
            `catalog-sync: no committed snapshot for source "${src.id}" ` +
              `(${path}), and --refresh is not set. Run ` +
              `\`catalog-sync generate --refresh\` to fetch ${src.url}.`
          )
        }

        // --refresh: force a live re-fetch (do NOT short-circuit on an existing
        // snapshot — refreshing is the whole point). Auth headers may embed
        // `env:VAR` tokens; if a referenced var is unset we can't authenticate,
        // so reuse the committed snapshot rather than fetch unauthenticated.
        const { headers, missing } = resolveHeaders(src.headers)
        if (missing.length > 0) {
          if (existing !== undefined) {
            process.stderr.write(
              `catalog-sync: skipping refresh of "${src.id}" — missing env ` +
                `${missing.join(", ")}; reusing committed snapshot.\n`
            )
            return JSON.parse(existing)
          }
          throw new Error(
            `catalog-sync: cannot refresh "${src.id}" — missing env ` +
              `${missing.join(", ")} and no committed snapshot.`
          )
        }
        const res = await fetch(src.url, {
          method: src.method ?? "GET",
          headers,
          ...(src.body !== undefined
            ? { body: JSON.stringify(src.body) }
            : {}),
        })
        if (!res.ok) {
          throw new Error(
            `catalog-sync: fetch ${src.url} failed: ${res.status} ${res.statusText}`
          )
        }
        const text = await res.text()
        const parsed: unknown = JSON.parse(text)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
        return parsed
      },
    }

    const out = await gen.generate(ctx)
    for (const [path, content] of Object.entries(out)) {
      files[path] = content
    }
  }

  const root = repoRoot()
  const changed: string[] = []
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath)
    const existing = readIfExists(abs)
    if (existing !== content) {
      changed.push(relPath)
      if (opts.write) {
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content, "utf8")
      }
    }
  }

  return { files, changed }
}
