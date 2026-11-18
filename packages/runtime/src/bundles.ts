/**
 * `~/.agentproto/bundles.json` — named sets of imported MCPs + skills (+
 * optionally the daemon's own `/mcp`), attachable to any harness in one
 * `agent_start({bundles:["research"]})` call.
 *
 * Same load/save/atomic-write pattern as `user-presets.ts`; validation
 * against the live imported-MCP set is the single boundary every writer
 * (MCP tools, HTTP routes) goes through (`saveBundle`).
 */

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve as resolvePath } from "node:path"
import { z } from "zod"
import { loadImportedMcps, type ImportedMcpsConfig } from "./mcp-imports.js"

/** Per-import tool filter, applied on the `/mcp/imported/<id>` mount as
 *  `?allowTools=` / `?denyTools=`. Entries are exact tool names or `*`
 *  patterns (`list_*`). `deny` wins over `allow`. */
export interface BundleToolFilter {
  /** Only these tools are visible/callable. Non-empty when present. */
  allow?: string[]
  deny?: string[]
}

export interface Bundle {
  /** Stable machine-local id, e.g. `research`. */
  id: string
  label: string
  description?: string
  /** Imported-MCP ids (`mcp_imported_list`) to mount as native MCP servers
   *  on a spawn carrying this bundle. `"*"` expands at spawn time to the
   *  CURRENT import set (never validated at save time, never dangling).
   *  Opt-in only: no default config ships a bundle with `"*"` (dozens of
   *  tools per import would flood every harness palette). */
  mcpImports: string[] | "*"
  /** Optional per-import tool filters, keyed by import id (each key must be
   *  in `mcpImports`, or any id when `mcpImports` is `"*"`). Imports without
   *  an entry expose every tool. */
  toolFilters?: Record<string, BundleToolFilter>
  /** Also mount the daemon's own scoped `/mcp` — the same entry the
   *  claude-code/hermes self-mount default builds. */
  includeDaemon?: boolean
  /** Skills unioned into the spawn's resolved skill list. */
  skills: string[]
}

const bundleIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase kebab-case (letters, digits, hyphens)")

const toolPatternSchema = z
  .string()
  .min(1)
  .refine(v => !v.includes(","), "tool names/patterns cannot contain a comma")

const toolFilterSchema = z.object({
  allow: z.array(toolPatternSchema).min(1, "allow must be non-empty (omit it to allow every tool)").optional(),
  deny: z.array(toolPatternSchema).optional(),
})

const bundleSchema = z.object({
  id: bundleIdSchema,
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  mcpImports: z.union([z.array(z.string().min(1)), z.literal("*")]),
  toolFilters: z.record(z.string().min(1), toolFilterSchema).optional(),
  includeDaemon: z.boolean().optional(),
  skills: z.array(z.string().min(1)),
}) satisfies z.ZodType<Bundle>

const bundlesFileSchema = z.object({
  version: z.literal(1),
  bundles: z.array(bundleSchema),
})

export type BundlesFile = z.infer<typeof bundlesFileSchema>

/** Built-in bundle that carries the Bureau MCP import + the shared browser
 *  skill. A user bundle with the same id in `bundles.json` replaces it. */
export const BUILTIN_BROWSER_BUNDLE_ID = "browser"
export const BUILTIN_BROWSER_BUNDLE_LABEL = "Browser (Bureau)"

/**
 * The built-in `browser` bundle: every imported entry whose alias equals
 * `defaults.browser.proxyImport` (none when unset), plus the `browser` skill.
 * Pure, so bundle_list, spawn expansion and tests share one definition.
 */
export function builtinBrowserBundle(
  proxyImport: string | undefined,
  imported: ImportedMcpsConfig,
): Bundle {
  const mcpImports = proxyImport
    ? imported.imports.filter(entry => entry.alias === proxyImport).map(entry => entry.id)
    : []
  return {
    id: BUILTIN_BROWSER_BUNDLE_ID,
    label: BUILTIN_BROWSER_BUNDLE_LABEL,
    mcpImports,
    skills: ["browser"],
  }
}

/** User bundles plus every built-in one; a user bundle with a built-in's id
 *  wins (same policy as the rest of the daemon's user-over-builtin stores).
 *  The built-in `browser` bundle exists only once `defaults.browser.proxyImport`
 *  names a Bureau import: on a host without one it would mount nothing. */
export function effectiveBundles(
  userBundles: readonly Bundle[],
  proxyImport: string | undefined,
  imported: ImportedMcpsConfig,
): Bundle[] {
  const ids = new Set(userBundles.map(bundle => bundle.id))
  return !proxyImport || ids.has(BUILTIN_BROWSER_BUNDLE_ID)
    ? [...userBundles]
    : [...userBundles, builtinBrowserBundle(proxyImport, imported)]
}

export const BUNDLES_PATH = (): string => resolvePath(homedir(), ".agentproto", "bundles.json")

function emptyFile(): BundlesFile {
  return { version: 1, bundles: [] }
}

/** Missing or malformed user config is treated as empty — a bad bundle must
 * never prevent the daemon from starting. Writes always restore valid JSON. */
export async function loadBundles(path: string = BUNDLES_PATH()): Promise<BundlesFile> {
  try {
    return bundlesFileSchema.parse(JSON.parse(await fs.readFile(path, "utf8")))
  } catch {
    return emptyFile()
  }
}

async function writeBundles(file: BundlesFile, path: string = BUNDLES_PATH()): Promise<void> {
  const dir = dirname(path)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  await fs.rename(tmp, path)
}

export async function listBundles(): Promise<Bundle[]> {
  return (await loadBundles()).bundles
}

export async function getBundle(id: string): Promise<Bundle | undefined> {
  return (await loadBundles()).bundles.find(b => b.id === id)
}

/** Thrown by `saveBundle` when `mcpImports` names an id not present in the
 *  live imported-MCP set — the create/update validation boundary. */
export class BundleValidationError extends Error {}

/** `bundle.mcpImports` ids that are no longer in the live imported-MCP set —
 *  the id was valid at save time but the import was later removed
 *  (`mcp_imported_remove`). Used by `bundle_list` to flag dangling refs and
 *  by the spawn-expansion path to skip them with a warning. */
export function danglingImports(bundle: Bundle, importedIds: ReadonlySet<string>): string[] {
  if (bundle.mcpImports === "*") return []
  return bundle.mcpImports.filter(id => !importedIds.has(id))
}

async function assertImportsKnown(mcpImports: string[] | "*"): Promise<void> {
  if (mcpImports === "*" || mcpImports.length === 0) return
  const imported = await loadImportedMcps()
  const validIds = new Set(imported.imports.map(e => e.id))
  const unknown = mcpImports.filter(id => !validIds.has(id))
  if (unknown.length > 0) {
    throw new BundleValidationError(
      `unknown mcpImports id(s): ${unknown.join(", ")}. Valid ids: ${
        [...validIds].join(", ") || "(none imported — run mcp_import first)"
      }`,
    )
  }
}

/** Every `toolFilters` key must be an id in `mcpImports` (any id when it is
 *  `"*"`, which expands at spawn time) — a filter for an unmounted import
 *  would silently do nothing. */
function assertToolFiltersKnown(bundle: Pick<Bundle, "mcpImports" | "toolFilters">): void {
  if (!bundle.toolFilters || bundle.mcpImports === "*") return
  const mounted = new Set(bundle.mcpImports)
  const stray = Object.keys(bundle.toolFilters).filter(id => !mounted.has(id))
  if (stray.length > 0) {
    throw new BundleValidationError(
      `toolFilters key(s) not in mcpImports: ${stray.join(", ")}. Add them to mcpImports or drop the filter.`,
    )
  }
}

/** Create a new bundle. Throws (Zod) on a malformed shape, or
 *  `BundleValidationError` when `mcpImports` names an unknown import id.
 *  Rejects when `id` already exists — use `updateBundle` to modify one. */
export async function createBundle(bundle: Bundle): Promise<Bundle> {
  const validated = bundleSchema.parse(bundle)
  await assertImportsKnown(validated.mcpImports)
  assertToolFiltersKnown(validated)
  const file = await loadBundles()
  if (file.bundles.some(b => b.id === validated.id)) {
    throw new BundleValidationError(`bundle "${validated.id}" already exists — use bundle_update.`)
  }
  file.bundles.push(validated)
  await writeBundles(file)
  return validated
}

/** Merge `patch` onto the existing bundle named `id` and persist it. Throws
 *  `BundleValidationError` when `id` doesn't exist or the merged
 *  `mcpImports` names an unknown import id. */
export async function updateBundle(
  id: string,
  patch: Partial<Omit<Bundle, "id">>,
): Promise<Bundle> {
  const file = await loadBundles()
  const index = file.bundles.findIndex(b => b.id === id)
  if (index === -1) {
    throw new BundleValidationError(`bundle "${id}" not found — use bundle_create.`)
  }
  const existing = file.bundles[index]!
  const merged = bundleSchema.parse({ ...existing, ...patch, id })
  await assertImportsKnown(merged.mcpImports)
  assertToolFiltersKnown(merged)
  file.bundles[index] = merged
  await writeBundles(file)
  return merged
}

export async function deleteBundle(id: string): Promise<boolean> {
  const file = await loadBundles()
  const index = file.bundles.findIndex(b => b.id === id)
  if (index === -1) return false
  file.bundles.splice(index, 1)
  await writeBundles(file)
  return true
}
