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
        if (existing !== undefined) {
          return JSON.parse(existing)
        }
        if (!opts.refresh) {
          throw new Error(
            `catalog-sync: no committed snapshot for source "${src.id}" ` +
              `(${path}), and --refresh is not set. Run ` +
              `\`catalog-sync generate --refresh\` to fetch ${src.url}.`
          )
        }
        const res = await fetch(src.url)
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
