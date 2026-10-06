#!/usr/bin/env node
/**
 * Sync the embedded first-party catalog (`src/first-party-catalog.ts`)
 * from the published catalog at `DEFAULT_CATALOG_SOURCE_URL`.
 *
 * Usage:
 *   pnpm --filter @agentproto/runtime catalog:first-party
 *   AGENTPROTO_CATALOG_URL=https://staging.example/apps.json pnpm --filter @agentproto/runtime catalog:first-party
 *   pnpm --filter @agentproto/runtime catalog:first-party ./local-apps.json
 *
 * Downloads the `app-catalog/v1` document, validates every entry against
 * `AppCatalogEntrySchema`, and rewrites `src/first-party-catalog.ts` via
 * `renderFirstPartyCatalogTs` (shared with `agentproto catalog build
 * --emit-ts` -- the same code, not a copy). A failed fetch or one invalid
 * entry exits 1 and leaves the file untouched, so a half-written fallback
 * can never ship.
 *
 * Requires a built package (`pnpm --filter @agentproto/runtime build`): it
 * imports the compiled helpers from `dist/`, not the TS sources.
 */

import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import { AppCatalogEntrySchema } from "../dist/app-catalog.mjs"
import { renderFirstPartyCatalogTs } from "../dist/first-party-catalog-gen.mjs"

const DEFAULT_URL = "https://agentproto.sh/catalog/v1/apps.json"
const TARGET = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "first-party-catalog.ts")

async function loadCatalog() {
  const arg = process.argv[2]
  const url = arg ?? process.env.AGENTPROTO_CATALOG_URL ?? DEFAULT_URL
  if (arg !== undefined) {
    // A local file argument is a path relative to cwd, not a URL.
    if (/^https?:\/\//.test(arg)) return fetchJson(arg)
    return JSON.parse(await readFile(arg, "utf8"))
  }
  if (/^https?:\/\//.test(url)) return fetchJson(url)
  return JSON.parse(await readFile(url, "utf8"))
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

let doc
try {
  doc = await loadCatalog()
} catch (err) {
  console.error(`sync-first-party-catalog: catalog fetch/load failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
if (doc === null || typeof doc !== "object" || !Array.isArray(doc.entries)) {
  console.error("sync-first-party-catalog: expected { entries: [...] }")
  process.exit(1)
}

const entries = []
for (let i = 0; i < doc.entries.length; i++) {
  const parsed = AppCatalogEntrySchema.safeParse(doc.entries[i])
  if (!parsed.success) {
    console.error(
      `sync-first-party-catalog: entries[${i}] invalid: ${parsed.error.issues
        .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
        .join("; ")}`,
    )
    process.exit(1)
  }
  entries.push(parsed.data)
}

await writeFile(TARGET, renderFirstPartyCatalogTs(entries), "utf8")
console.log(`sync-first-party-catalog: wrote ${entries.length} entr${entries.length === 1 ? "y" : "ies"} -> ${TARGET}`)
