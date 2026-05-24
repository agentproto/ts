/**
 * Register a chrome-devtools-mcp invocation in
 * `~/.agentproto/imported-mcps.json` so the daemon's MCP proxy
 * picks it up on next restart and exposes its 29 browser tools
 * (navigate, click, type, screenshot, …) through `/mcp` to every
 * tunnel-connected host.
 *
 * Schema mirrors what `@agentproto/runtime`'s mcp-imports loader
 * normalises into `{ version, imports[] }`. We write directly
 * instead of depending on @agentproto/runtime — keeps this plugin
 * a leaf package with no workspace coupling, and the loader's
 * `normalize()` casts our snapshot back to its `DiscoveredMcp`
 * type at read time without runtime validation.
 *
 * Entry id is namespaced under `plugin:local-browser:<directory>`
 * so re-running setup with a different profile updates the same
 * row instead of accumulating.
 */

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const IMPORTED_MCPS_PATH = (home: string = homedir()): string =>
  join(home, ".agentproto", "imported-mcps.json")

const IMPORT_ID_PREFIX = "plugin:local-browser"
const IMPORT_ALIAS = "local-browser"

export interface RegisterOptions {
  /** Absolute path to the agentproto Chrome user-data-dir clone. */
  userDataDir: string
  /** Profile directory inside the user-data-dir to drive
   *  (`Default`, `Profile 1`, …). */
  profileDirectory: string
  /** Pin the chrome-devtools-mcp version (default `latest`). */
  chromeMcpVersion?: string
  /** Override the path to imported-mcps.json (for tests). */
  importsPath?: string
  /** Additional Chrome flags. The plugin already passes
   *  `--profile-directory=...`; you can add headless, viewport, etc. */
  extraChromeArgs?: string[]
}

export interface RegisterResult {
  /** Absolute path that was written. */
  importsPath: string
  /** True when an existing entry was overwritten (vs created fresh). */
  replaced: boolean
  /** The id we wrote. */
  id: string
}

interface ImportEntry {
  id: string
  alias: string
  addedAt: string
  snapshot: {
    id: string
    source: string
    scope: string
    name: string
    type: "stdio"
    command: string
    args: string[]
    env: Record<string, string>
  }
}

interface ImportedMcpsFile {
  version: number
  imports: ImportEntry[]
}

export async function registerLocalBrowser(
  opts: RegisterOptions
): Promise<RegisterResult> {
  const path = opts.importsPath ?? IMPORTED_MCPS_PATH()
  const version = opts.chromeMcpVersion ?? "latest"
  const id = `${IMPORT_ID_PREFIX}:${opts.profileDirectory}`

  const args = [
    "-y",
    `chrome-devtools-mcp@${version}`,
    "--userDataDir",
    opts.userDataDir,
    `--chromeArg=--profile-directory=${opts.profileDirectory}`,
  ]
  for (const extra of opts.extraChromeArgs ?? []) {
    args.push(`--chromeArg=${extra}`)
  }

  const entry: ImportEntry = {
    id,
    alias: IMPORT_ALIAS,
    addedAt: new Date().toISOString(),
    snapshot: {
      id,
      source: "plugin",
      scope: "plugin:local-browser",
      name: IMPORT_ALIAS,
      type: "stdio",
      command: "npx",
      args,
      env: {},
    },
  }

  const current = await loadFile(path)
  const others = current.imports.filter(
    e => e.id !== id && !e.id.startsWith(`${IMPORT_ID_PREFIX}:`)
  )
  const replaced =
    current.imports.length !== others.length ||
    current.imports.some(e => e.id === id)
  const next: ImportedMcpsFile = {
    version: 1,
    imports: [...others, entry],
  }

  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8")
  await fs.rename(tmp, path)

  return { importsPath: path, replaced, id }
}

export async function unregisterLocalBrowser(
  importsPath: string = IMPORTED_MCPS_PATH()
): Promise<{ removed: number }> {
  const current = await loadFile(importsPath)
  const others = current.imports.filter(
    e => !e.id.startsWith(`${IMPORT_ID_PREFIX}:`)
  )
  const removed = current.imports.length - others.length
  if (removed === 0) return { removed: 0 }
  const next: ImportedMcpsFile = { version: 1, imports: others }
  await fs.mkdir(dirname(importsPath), { recursive: true })
  const tmp = `${importsPath}.tmp.${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8")
  await fs.rename(tmp, importsPath)
  return { removed }
}

async function loadFile(path: string): Promise<ImportedMcpsFile> {
  try {
    const raw = await fs.readFile(path, "utf8")
    const parsed = JSON.parse(raw) as Partial<ImportedMcpsFile>
    const imports = Array.isArray(parsed.imports) ? parsed.imports : []
    return { version: 1, imports: imports as ImportEntry[] }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, imports: [] }
    }
    throw err
  }
}
