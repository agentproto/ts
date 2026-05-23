/**
 * Preset discovery — walk every configured preset package, read its
 * manifest, build a flat slug → preset-entry map.
 *
 * Configured packages come from `~/.agentproto/config.json`:
 *
 *   { "corpusPresetPackages": ["@agentproto/corpus-presets",
 *                              "@vendor/corpus-presets"] }
 *
 * Default when the config is missing or empty: just
 * `@agentproto/corpus-presets`.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { CorpusPreset } from "@agentproto/corpus"
import {
  CorpusPresetManifestSchema,
  type CorpusPresetEntry,
  type CorpusPresetManifest,
} from "./preset-manifest.js"

const DEFAULT_PRESET_PACKAGES = ["@agentproto/corpus-presets"] as const

export interface ResolvedPresetEntry extends CorpusPresetEntry {
  /** npm package the entry was discovered in. */
  readonly packageName: string
  /** Absolute path to the package root (where the manifest was read from). */
  readonly packageRoot: string
}

/**
 * Discover every preset declared across the configured preset
 * packages. Returns a flat map slug → entry. If two packages declare
 * the same slug, last-write-wins (later packages in the config override).
 */
export async function discoverPresets(): Promise<
  Map<string, ResolvedPresetEntry>
> {
  const packages = await readConfiguredPresetPackages()
  const out = new Map<string, ResolvedPresetEntry>()
  for (const pkg of packages) {
    const result = await readPresetManifest(pkg)
    if (!result) continue
    const { manifest, packageRoot } = result
    for (const entry of manifest.presets) {
      out.set(entry.slug, {
        ...entry,
        packageName: pkg,
        packageRoot,
      })
    }
  }
  return out
}

/**
 * Load a single preset by slug. Returns null if no configured package
 * declares it. Throws if the entry exists but its module/export
 * doesn't load.
 */
export async function loadPreset(
  slug: string
): Promise<CorpusPreset | null> {
  const presets = await discoverPresets()
  const entry = presets.get(slug)
  if (!entry) return null

  const abs = entry.entry.startsWith(".")
    ? join(entry.packageRoot, entry.entry)
    : entry.entry
  const url = entry.entry.startsWith(".") ? pathToFileURL(abs).href : entry.entry
  const mod = (await import(url)) as Record<string, unknown>
  const exported = mod[entry.export]
  if (!exported || typeof exported !== "object") {
    throw new Error(
      `corpus-presets: '${entry.packageName}' entry '${entry.entry}' has no object export '${entry.export}' (got ${typeof exported}).`
    )
  }
  return exported as CorpusPreset
}

/**
 * Resolve `<pkg>/package.json` from both the CLI's own location AND
 * the user's cwd, so locally-installed preset packages work.
 */
async function readPresetManifest(
  packageName: string
): Promise<{ manifest: CorpusPresetManifest; packageRoot: string } | null> {
  const packageJsonPath = resolvePackageJson(packageName)
  if (!packageJsonPath) return null
  const packageRoot = dirname(packageJsonPath)

  // 1. Standalone agentproto-corpus-preset.json wins if present.
  const standalonePath = join(packageRoot, "agentproto-corpus-preset.json")
  const standalone = await readJsonIfExists(standalonePath)
  if (standalone !== undefined) {
    return {
      manifest: CorpusPresetManifestSchema.parse(standalone),
      packageRoot,
    }
  }

  // 2. Fall back to package.json#agentproto-corpus-preset.
  const pkgJson = (await readJsonIfExists(packageJsonPath)) as
    | { "agentproto-corpus-preset"?: unknown }
    | undefined
  const block = pkgJson?.["agentproto-corpus-preset"]
  if (block && typeof block === "object") {
    return {
      manifest: CorpusPresetManifestSchema.parse(block),
      packageRoot,
    }
  }

  return null
}

function resolvePackageJson(packageName: string): string | null {
  const candidates = [
    import.meta.url,
    pathToFileURL(join(process.cwd(), "package.json")).href,
  ]
  for (const root of candidates) {
    try {
      return createRequire(root).resolve(`${packageName}/package.json`)
    } catch {
      // try next root
    }
  }
  return null
}

async function readJsonIfExists(path: string): Promise<unknown> {
  try {
    const raw = await readFile(path, "utf8")
    return JSON.parse(raw)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw err
  }
}

interface AgentprotoConfig {
  corpusPresetPackages?: readonly string[]
}

async function readConfiguredPresetPackages(): Promise<readonly string[]> {
  const base = process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
  const path = join(base, "config.json")
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as AgentprotoConfig
    const list = parsed.corpusPresetPackages
    if (Array.isArray(list) && list.length > 0) return list
  } catch {
    // ENOENT or parse error — fall through to default
  }
  return DEFAULT_PRESET_PACKAGES
}
