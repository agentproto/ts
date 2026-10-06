/**
 * `agentproto catalog build <entry.json|dir>... --out <apps.json>
 *   [--base <apps.json>] [--check] [--emit-ts <file.ts>]
 *   [--generated-at <iso>]`
 *
 * Merges `*.entry.json` catalog entries (as written by `app pack --release
 * --entry`) into a deterministic `app-catalog/v1` document -- the file
 * published at `DEFAULT_CATALOG_SOURCE_URL`. Entries are validated with the
 * runtime's `AppCatalogEntrySchema`, merged by `appId` (higher version
 * wins), sorted, and written with 2-space indent + trailing newline.
 *
 * `--check` writes nothing and exits 1 when `--out` would change
 * (ignoring `generatedAt`) -- the CI guard against drift. `--emit-ts`
 * additionally renders the embedded first-party fallback file via
 * `renderFirstPartyCatalogTs` (shared with the `catalog:first-party` sync
 * script).
 */

import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

import { AppCatalogEntrySchema, compareCatalogVersions, type AppCatalogEntry } from "@agentproto/runtime/app-catalog"
import {
  buildCatalogDocument,
  mergeCatalogEntries,
  renderFirstPartyCatalogTs,
  serializeCatalogDocument,
} from "@agentproto/runtime/first-party-catalog-gen"

const USAGE = `agentproto catalog -- build the published app catalog

Usage:
  agentproto catalog build <entry.json|dir>... --out <apps.json>
                           [--base <apps.json>] [--check] [--emit-ts <file.ts>]
                           [--generated-at <iso>]

Reads each argument: a \`*.entry.json\` file (as written by
\`agentproto app pack --release --entry\`) or a directory (scanned
non-recursively for \`*.entry.json\` files). Validates every entry against
AppCatalogEntrySchema; an invalid entry exits 1 naming the file.

Merge rules, per appId: the incoming entry replaces the base one when its
version is >= (compareCatalogVersions); an older incoming version prints a
warning and the existing entry stays.

Output (deterministic): { schema: "app-catalog/v1", generatedAt, entries }
sorted by appId, 2-space indent, trailing newline. generatedAt is kept from
--base when no entry changed, so a no-op build produces no diff.

--check: write nothing; exit 1 when --out differs from the result
(ignoring generatedAt).
--emit-ts <file.ts>: also render the embedded first-party catalog TS file
(packages/runtime/src/first-party-catalog.ts).`

interface BuildOutcome {
  doc: ReturnType<typeof buildCatalogDocument>
  warnings: string[]
  changed: boolean
}

/** Load + validate a catalog document from disk. A missing file is an
 *  empty base (as specified); a malformed one is a hard error. */
async function loadBase(path: string): Promise<{ entries: AppCatalogEntry[]; generatedAt?: string }> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] }
    throw new Error(`cannot read base catalog ${path}: ${(err as Error).message}`)
  }
  let parsed: { schema?: unknown; generatedAt?: unknown; entries?: unknown }
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`base catalog ${path} is not valid JSON: ${(err as Error).message}`)
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.entries)) {
    throw new Error(`base catalog ${path}: expected { entries: [...] }`)
  }
  const entries: AppCatalogEntry[] = []
  for (let i = 0; i < parsed.entries.length; i++) {
    const res = AppCatalogEntrySchema.safeParse(parsed.entries[i])
    if (!res.success) {
      const detail = res.error.issues.map((iss) => `${iss.path.join(".")}: ${iss.message}`).join("; ")
      throw new Error(`base catalog ${path}: entries[${i}] invalid (${detail})`)
    }
    entries.push(res.data)
  }
  return {
    entries,
    ...(typeof parsed.generatedAt === "string" ? { generatedAt: parsed.generatedAt } : {}),
  }
}

/** Collect `*.entry.json` paths from the positional args (files and
 *  non-recursive directories). */
async function collectEntryPaths(args: readonly string[]): Promise<string[]> {
  const paths: string[] = []
  for (const arg of args) {
    const abs = resolve(arg)
    const st = await stat(abs).catch(() => undefined)
    if (st === undefined) throw new Error(`entry path not found: ${abs}`)
    if (st.isDirectory()) {
      const names = (await readdir(abs)).filter((n) => n.endsWith(".entry.json")).sort()
      if (names.length === 0) throw new Error(`no *.entry.json files in ${abs}`)
      for (const n of names) paths.push(join(abs, n))
    } else {
      paths.push(abs)
    }
  }
  if (paths.length === 0) throw new Error("at least one <entry.json|dir> is required")
  return paths
}

async function readEntry(path: string): Promise<AppCatalogEntry> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (err) {
    throw new Error(`cannot read entry ${path}: ${(err as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`entry ${path} is not valid JSON: ${(err as Error).message}`)
  }
  const res = AppCatalogEntrySchema.safeParse(parsed)
  if (!res.success) {
    const detail = res.error.issues.map((iss) => `${iss.path.join(".")}: ${iss.message}`).join("; ")
    throw new Error(`entry ${path} invalid (${detail})`)
  }
  return res.data
}

/** Entries equal ignoring nothing (both sides validated, key order may
 *  differ -- compare canonically). */
function entriesEqual(a: readonly AppCatalogEntry[], b: readonly AppCatalogEntry[]): boolean {
  return canonical(sortForCompare(a)) === canonical(sortForCompare(b))
}

/** JSON with object keys sorted, so semantically equal entries compare
 *  equal regardless of how each file was written. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>
    return `{${Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function sortForCompare(entries: readonly AppCatalogEntry[]): AppCatalogEntry[] {
  return [...entries].sort((x, y) => (x.appId < y.appId ? -1 : x.appId > y.appId ? 1 : 0))
}

async function build(
  entryArgs: readonly string[],
  opts: {
    base?: string
    generatedAt?: string
  },
): Promise<BuildOutcome> {
  const base = opts.base !== undefined ? await loadBase(opts.base) : { entries: [] }
  const paths = await collectEntryPaths(entryArgs)
  const incoming: AppCatalogEntry[] = []
  for (const p of paths) incoming.push(await readEntry(p))
  const { entries, skipped } = mergeCatalogEntries(base.entries, incoming, compareCatalogVersions)
  const warnings = [...skipped.values()].map((w) => `agentproto catalog build: ${w}`)
  const changed = !entriesEqual(entries, base.entries)
  const generatedAt = opts.generatedAt ?? (changed ? new Date().toISOString() : (base.generatedAt ?? new Date().toISOString()))
  return { doc: buildCatalogDocument(entries, generatedAt), warnings, changed }
}

/** `agentproto catalog build ...` */
export async function runCatalog(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgsSafe(args)
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const sub = positionals[0]
  if (sub !== "build") {
    process.stderr.write(
      `agentproto catalog: unknown sub-command${sub ? ` '${sub}'` : ""}.\n${USAGE}\n`,
    )
    return 2
  }
  const rest = positionals.slice(1)
  const outArg = typeof values.out === "string" ? values.out : undefined
  if (outArg === undefined) {
    process.stderr.write(`agentproto catalog build: --out <apps.json> is required.\n${USAGE}\n`)
    return 2
  }
  const out = resolve(outArg)
  const check = values.check === true
  const base = typeof values.base === "string" ? resolve(values.base) : undefined
  const emitTs = typeof values["emit-ts"] === "string" ? resolve(values["emit-ts"]) : undefined
  const generatedAt = typeof values["generated-at"] === "string" ? values["generated-at"] : undefined

  let outcome: BuildOutcome
  try {
    outcome = await build(rest, { ...(base !== undefined ? { base } : {}), ...(generatedAt !== undefined ? { generatedAt } : {}) })
  } catch (err) {
    process.stderr.write(`agentproto catalog build: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  for (const w of outcome.warnings) process.stderr.write(w + "\n")

  const serialized = serializeCatalogDocument(outcome.doc)

  if (check) {
    let existingRaw: string | undefined
    try {
      existingRaw = await readFile(out, "utf8")
    } catch {
      // missing --out under --check is a difference
    }
    let same = false
    if (existingRaw !== undefined) {
      try {
        const existing = JSON.parse(existingRaw) as { schema?: unknown; entries?: unknown }
        same =
          existing.schema === outcome.doc.schema &&
          canonical(existing.entries) === canonical(outcome.doc.entries)
      } catch {
        same = false
      }
    }
    if (!same) {
      process.stderr.write(`agentproto catalog build: --check failed: ${out} is out of date with the given entries.\n`)
      return 1
    }
    process.stdout.write(`agentproto catalog build: ${out} is up to date.\n`)
    return 0
  }

  await writeFile(out, serialized, "utf8")
  if (emitTs !== undefined) {
    await writeFile(emitTs, renderFirstPartyCatalogTs(outcome.doc.entries), "utf8")
  }
  const count = outcome.doc.entries.length
  process.stdout.write(
    `agentproto catalog build: ${count} entr${count === 1 ? "y" : "ies"} -> ${out}` +
      (emitTs !== undefined ? ` (+ ${emitTs})` : "") +
      "\n",
  )
  return 0
}

/** parseArgs wrapper: strict:false so unknown flags surface as our own
 *  usage error instead of a thrown exception. */
function parseArgsSafe(args: readonly string[]): {
  values: Record<string, string | boolean | undefined>
  positionals: string[]
} {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: "boolean", short: "h" },
      out: { type: "string" },
      base: { type: "string" },
      check: { type: "boolean" },
      "emit-ts": { type: "string" },
      "generated-at": { type: "string" },
    },
  })
  return { values: values as Record<string, string | boolean | undefined>, positionals }
}
