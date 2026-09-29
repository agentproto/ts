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
import { loadImportedMcps } from "./mcp-imports.js"

export interface Bundle {
  /** Stable machine-local id, e.g. `research`. */
  id: string
  label: string
  description?: string
  /** Imported-MCP ids (`mcp_imported_list`) to mount as native MCP servers
   *  on a spawn carrying this bundle. */
  mcpImports: string[]
  /** Also mount the daemon's own scoped `/mcp` — the same entry the
   *  claude-code/hermes self-mount default builds. */
  includeDaemon?: boolean
  /** Skills unioned into the spawn's resolved skill list. */
  skills: string[]
}

const bundleIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase kebab-case (letters, digits, hyphens)")

const bundleSchema = z.object({
  id: bundleIdSchema,
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  mcpImports: z.array(z.string().min(1)),
  includeDaemon: z.boolean().optional(),
  skills: z.array(z.string().min(1)),
}) satisfies z.ZodType<Bundle>

const bundlesFileSchema = z.object({
  version: z.literal(1),
  bundles: z.array(bundleSchema),
})

export type BundlesFile = z.infer<typeof bundlesFileSchema>

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
  return bundle.mcpImports.filter(id => !importedIds.has(id))
}

async function assertImportsKnown(mcpImports: string[]): Promise<void> {
  if (mcpImports.length === 0) return
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

/** Create a new bundle. Throws (Zod) on a malformed shape, or
 *  `BundleValidationError` when `mcpImports` names an unknown import id.
 *  Rejects when `id` already exists — use `updateBundle` to modify one. */
export async function createBundle(bundle: Bundle): Promise<Bundle> {
  const validated = bundleSchema.parse(bundle)
  await assertImportsKnown(validated.mcpImports)
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
