/**
 * `~/.agentproto/imported-mcps.json` — the user's curated set of
 * discovered MCPs they want the daemon to know about. v1 is just
 * persistence + read-side; the actual MCP-proxy implementation
 * (where the daemon's /mcp endpoint aggregates the imported
 * servers' tools under namespace prefixes) is v2 work.
 *
 * Purpose: today, "I see you have chrome-devtools in claude" is
 * read-only. Once a user imports it, the operator agent can refer
 * to it ("the user said it's enabled — call it") and a future
 * proxy layer can actually expose it. We persist the choice now so
 * the data is in place when the proxy lands.
 *
 * File shape:
 *   {
 *     "version": 1,
 *     "imports": [
 *       {
 *         "id":         "claude-code:project:/path:chrome-devtools",
 *         "alias":      "chrome-devtools",
 *         "addedAt":    "2026-05-10T...",
 *         "snapshot":   { ...the DiscoveredMcp at import time }
 *       }
 *     ]
 *   }
 *
 * Snapshotting at import time keeps the daemon resilient to the
 * source config getting deleted (user runs `claude mcp remove ...`).
 * The imported entry stays usable; only the next discovery pass
 * stops listing it as "available to import."
 */

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve as resolvePath } from "node:path"
import type { DiscoveredMcp } from "./mcp-discovery.js"

export const IMPORTED_MCPS_PATH = (): string =>
  resolvePath(homedir(), ".agentproto", "imported-mcps.json")

export const IMPORTED_MCPS_VERSION = 1 as const

export interface ImportedMcpEntry {
  id: string
  alias: string
  addedAt: string
  snapshot: DiscoveredMcp
}

export interface ImportedMcpsConfig {
  version: typeof IMPORTED_MCPS_VERSION
  imports: ImportedMcpEntry[]
}

const EMPTY: ImportedMcpsConfig = {
  version: IMPORTED_MCPS_VERSION,
  imports: [],
}

export async function loadImportedMcps(
  path: string = IMPORTED_MCPS_PATH()
): Promise<ImportedMcpsConfig> {
  let raw: string
  try {
    raw = await fs.readFile(path, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `agentproto: ${path} is not valid JSON (${
        err instanceof Error ? err.message : String(err)
      }). Delete or fix manually.`
    )
  }
  return normalize(parsed)
}

export async function saveImportedMcps(
  config: ImportedMcpsConfig,
  path: string = IMPORTED_MCPS_PATH()
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + "\n", "utf8")
  await fs.rename(tmp, path)
}

/**
 * Add (or replace) an import. Snapshots the discovered MCP at
 * import time so the entry stays usable when the source config
 * disappears.
 */
export function addImport(
  config: ImportedMcpsConfig,
  input: { snapshot: DiscoveredMcp; alias?: string }
): ImportedMcpsConfig {
  const alias = (input.alias ?? input.snapshot.name).trim()
  if (!alias) {
    throw new Error("addImport: alias resolves to empty string")
  }
  const addedAt = new Date().toISOString()
  const next: ImportedMcpEntry = {
    id: input.snapshot.id,
    alias,
    addedAt,
    snapshot: input.snapshot,
  }
  const others = config.imports.filter(e => e.id !== input.snapshot.id)
  return { ...config, imports: [...others, next] }
}

export function removeImport(
  config: ImportedMcpsConfig,
  id: string
): ImportedMcpsConfig {
  return { ...config, imports: config.imports.filter(e => e.id !== id) }
}

export function findImport(
  config: ImportedMcpsConfig,
  id: string
): ImportedMcpEntry | undefined {
  return config.imports.find(e => e.id === id)
}

function normalize(parsed: unknown): ImportedMcpsConfig {
  if (!parsed || typeof parsed !== "object") return EMPTY
  const obj = parsed as Record<string, unknown>
  const imports: ImportedMcpEntry[] = []
  if (Array.isArray(obj.imports)) {
    for (const entry of obj.imports) {
      if (!entry || typeof entry !== "object") continue
      const e = entry as Record<string, unknown>
      const id = typeof e.id === "string" ? e.id : ""
      const alias = typeof e.alias === "string" ? e.alias : id
      const addedAt =
        typeof e.addedAt === "string" ? e.addedAt : new Date().toISOString()
      const snapshot = e.snapshot as DiscoveredMcp | undefined
      if (!id || !snapshot) continue
      imports.push({ id, alias, addedAt, snapshot })
    }
  }
  return { version: IMPORTED_MCPS_VERSION, imports }
}
