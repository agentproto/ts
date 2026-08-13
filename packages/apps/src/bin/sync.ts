#!/usr/bin/env node
/**
 * `agentproto-apps-sync` — emit every bundled `@agentproto/apps` app to disk
 * and write a catalog of what landed where.
 *
 * Each app's `AGENT.md` / `WORKFLOW.md` / `APP.md` manifests are written
 * under `<baseDir>/<slug>` via `AppHandle.emit` (see `@agentproto/app-kit`'s
 * `emitApp`); the catalog is a flat index a host can read without walking
 * every app's directory (`app_install`'s own discovery path already reads
 * each `APP.md` individually — this is a cheaper "what's on disk" summary
 * for the sync bin's own log, not a replacement for that).
 */

import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { parseArgs } from "node:util"
import type { AppHandle } from "@agentproto/app-kit"
import { codeTeam } from "../code-team/index.js"
import { contentTeam } from "../content-team/index.js"
import { mailTriage } from "../mail-triage/index.js"
import { mediaViewer } from "../media-viewer/index.js"
import { sessionViewer } from "../session-viewer/index.js"

interface CatalogEntry {
  readonly appId: string
  readonly name: string
  readonly description: string
  readonly dir: string
  readonly category: string
}

const APPS: readonly { readonly slug: string; readonly category: string; readonly handle: AppHandle }[] = [
  { slug: "code-team", category: "team", handle: codeTeam },
  { slug: "content-team", category: "team", handle: contentTeam },
  { slug: "mail-triage", category: "app", handle: mailTriage },
  { slug: "media-viewer", category: "app", handle: mediaViewer },
  { slug: "session-viewer", category: "app", handle: sessionViewer },
]

export async function syncApps(baseDir: string): Promise<CatalogEntry[]> {
  const catalog: CatalogEntry[] = []
  for (const { slug, category, handle } of APPS) {
    const dir = join(baseDir, slug)
    await handle.emit(dir)
    catalog.push({
      appId: handle.id ?? slug,
      name: handle.name ?? slug,
      description: handle.description ?? "",
      dir,
      category,
    })
    console.log(`emitted ${handle.id ?? slug} -> ${dir}`)
  }
  return catalog
}

export async function writeCatalog(baseDir: string, catalog: readonly CatalogEntry[]): Promise<string> {
  const catalogPath = join(baseDir, "..", "app-catalog.json")
  await mkdir(dirname(catalogPath), { recursive: true })
  await writeFile(catalogPath, JSON.stringify({ apps: catalog }, null, 2) + "\n", "utf8")
  return catalogPath
}

async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: { "base-dir": { type: "string" } },
  })
  const baseDir = values["base-dir"] ?? join(homedir(), ".agentproto", "apps")

  await mkdir(baseDir, { recursive: true })
  const catalog = await syncApps(baseDir)
  const catalogPath = await writeCatalog(baseDir, catalog)
  console.log(`wrote catalog (${catalog.length} apps) -> ${catalogPath}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
