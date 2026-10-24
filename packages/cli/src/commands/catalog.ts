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

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { parseArgs } from "node:util"

import { unpackApp } from "@agentproto/app-kit"
import matter from "gray-matter"
import {
  AppCatalogEntrySchema,
  CATALOG_LISTING_LIMITS,
  compareCatalogVersions,
  type AppCatalogEntry,
} from "@agentproto/runtime/app-catalog"
import { downloadTo, DOWNLOAD_MAX_BYTES } from "@agentproto/runtime/app-remote-install"
import {
  buildCatalogDocument,
  mergeCatalogEntries,
  renderFirstPartyCatalogTs,
  serializeCatalogDocument,
} from "@agentproto/runtime/first-party-catalog-gen"

import { collectAppFindings } from "./app-init.js"
import { checkMediaBytes, listingIssues } from "../app-store-listing.js"

const USAGE = `agentproto catalog — build and verify the published app catalog

Usage:
  agentproto catalog build <entry.json|dir>... --out <apps.json>
                           [--base <apps.json>] [--check] [--emit-ts <file.ts>]
                           [--generated-at <iso>]
  agentproto catalog verify <entry.json|dir>... [--json] [--allow-git]
                            [--offline-file <appId>=<path.agentapp>]...
                            [--local-media <https-url-prefix>=<dir>]...

Reads each argument: a \`.json\` file of any name (as written by
\`agentproto app pack --release --entry\`, or an \`entries/<appId>.json\` of
the agentproto/apps repo) or a directory (walked recursively for \`*.json\`
files). Validates every entry against AppCatalogEntrySchema; an invalid
entry exits 1 naming the file.

build merge rules, per appId: the incoming entry replaces the base one when
its version is >= (compareCatalogVersions); an older incoming version
prints a warning and the existing entry stays. Without --base, the result
contains exactly the given entries (a removed app disappears from the
catalog); the same appId twice among the given entries is an error.

build output (deterministic): { schema: "app-catalog/v1", generatedAt,
entries } sorted by appId, 2-space indent, trailing newline. generatedAt is
kept from --base when no entry changed, so a no-op build produces no diff.

build --check: write nothing; exit 1 when --out differs from the result
(ignoring generatedAt).
build --emit-ts <file.ts>: also render the embedded first-party catalog TS
file (packages/runtime/src/first-party-catalog.ts).

verify downloads each entry's bundle (source.kind "agentapp", https only,
the same download caps as app_install), checks the file size against
source.size, unpacks it (verifying the manifest digest) into a temp dir,
and checks manifest.sha256 against source.sha256, that the unpacked APP.md
has the same id as appId and version as source.version, that it carries no
ui.build, and that the unpacked app passes \`app validate\`. git sources are
refused (the public catalog is bundles only) unless --allow-git.
verify exits 1 at the first failing entry by default; --json prints the
full per-entry report instead. --offline-file <appId>=<path.agentapp>
substitutes a local bundle for the download (testing without network).
verify also checks the store listing: tagline, longDescription, categories
and alt text limits, https URLs, and each icon/screenshot's format and
size (downloaded). --local-media <https-url-prefix>=<dir> reads media under
that URL prefix from <dir> instead, e.g. the agentproto/apps CI maps
https://raw.githubusercontent.com/agentproto/apps/main/ to its checkout so
media added by a pull request verify before they are merged.`

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

/** Collect `*.json` entry paths from the positional args: explicit files of
 *  any name, and directories walked RECURSIVELY (the `agentproto/apps` repo
 *  holds `entries/<appId>.json` in a nested tree). A directory holding no
 *  `*.json` contributes nothing: an empty catalog is valid (a fresh
 *  `agentproto/apps` has only `entries/.gitkeep`). */
async function collectEntryPaths(args: readonly string[]): Promise<string[]> {
  if (args.length === 0) throw new Error("at least one <entry.json|dir> is required")
  const paths: string[] = []
  for (const arg of args) {
    const abs = resolve(arg)
    const st = await stat(abs).catch(() => undefined)
    if (st === undefined) throw new Error(`entry path not found: ${abs}`)
    if (st.isDirectory()) {
      const found: string[] = []
      const walk = async (dir: string): Promise<void> => {
        for (const name of (await readdir(dir)).sort()) {
          const p = join(dir, name)
          const s = await stat(p)
          if (s.isDirectory()) await walk(p)
          else if (name.endsWith(".json")) found.push(p)
        }
      }
      await walk(abs)
      paths.push(...found)
    } else {
      paths.push(abs)
    }
  }
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
  // The given inputs are the WHOLE catalog when no --base: the same appId
  // twice among them is a mistake (which file would win?), not a merge.
  const seen = new Map<string, string>()
  for (let i = 0; i < incoming.length; i++) {
    const e = incoming[i]
    const p = paths[i]
    if (e === undefined || p === undefined) continue
    const prev = seen.get(e.appId)
    if (prev !== undefined) {
      throw new Error(`duplicate appId '${e.appId}' in the given entries (${prev} and ${p})`)
    }
    seen.set(e.appId, p)
  }
  const { entries, skipped } = mergeCatalogEntries(base.entries, incoming, compareCatalogVersions)
  const warnings = [...skipped.values()].map((w) => `agentproto catalog build: ${w}`)
  const changed = !entriesEqual(entries, base.entries)
  const generatedAt = opts.generatedAt ?? (changed ? new Date().toISOString() : (base.generatedAt ?? new Date().toISOString()))
  return { doc: buildCatalogDocument(entries, generatedAt), warnings, changed }
}

/** `agentproto catalog build ...` / `agentproto catalog verify ...` */
export async function runCatalog(args: readonly string[]): Promise<number> {
  // --offline-file may repeat (node:util parseArgs keeps only the last
  // occurrence), so pull those pairs out before parsing the rest.
  const offline = new Map<string, string>()
  const localMedia: Array<{ prefix: string; dir: string }> = []
  const restArgs: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === undefined) continue
    if (a === "--offline-file" || a.startsWith("--offline-file=")) {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i]
      if (typeof v !== "string") {
        process.stderr.write("agentproto catalog: --offline-file needs <appId>=<path.agentapp>.\n")
        return 2
      }
      const eq = v.indexOf("=")
      if (eq <= 0) {
        process.stderr.write(`agentproto catalog: --offline-file expects <appId>=<path.agentapp>, got "${v}".\n`)
        return 2
      }
      offline.set(v.slice(0, eq), resolve(v.slice(eq + 1).trim()))
      continue
    }
    if (a === "--local-media" || a.startsWith("--local-media=")) {
      const v = a.startsWith("--local-media=") ? a.slice("--local-media=".length) : args[++i]
      // The prefix is a URL (it contains "://"), so split on the LAST "=".
      const eq = typeof v === "string" ? v.lastIndexOf("=") : -1
      if (typeof v !== "string" || eq <= 0 || !/^https:\/\//i.test(v)) {
        process.stderr.write(`agentproto catalog: --local-media expects <https-url-prefix>=<dir>, got "${v ?? ""}".\n`)
        return 2
      }
      localMedia.push({ prefix: v.slice(0, eq), dir: resolve(v.slice(eq + 1).trim()) })
      continue
    }
    restArgs.push(a)
  }

  const { values, positionals } = parseArgsSafe(restArgs)
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const sub = positionals[0]
  if (sub !== "build" && sub !== "verify") {
    process.stderr.write(
      `agentproto catalog: unknown sub-command${sub ? ` '${sub}'` : ""}.\n${USAGE}\n`,
    )
    return 2
  }
  const rest = positionals.slice(1)
  if (sub === "verify") {
    return runCatalogVerify(rest, {
      offline,
      localMedia,
      json: values.json === true,
      allowGit: values["allow-git"] === true,
    })
  }

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

// ── verify ───────────────────────────────────────────────────────────────

/** One check's outcome for an entry's verify report. */
export interface VerifyCheck {
  name: string
  ok: boolean
  detail?: string
}

/** Per-entry verify report. */
export interface VerifyReport {
  appId: string
  file: string
  ok: boolean
  checks: VerifyCheck[]
}

const check = (name: string, ok: boolean, detail?: string): VerifyCheck => ({
  name,
  ok,
  ...(detail !== undefined ? { detail } : {}),
})

const okChecks = (...names: string[]): VerifyCheck[] => names.map((n) => check(n, true))

/** Checks an entry's bundle locally: size, unpack digest, APP.md id/version,
 *  no ui.build, and `app validate` on the unpacked tree. Returns the checks
 *  after the bundle is on disk; a thrown error becomes a failed check. */
async function verifyBundleOnDisk(
  bundle: string,
  entry: AppCatalogEntry,
): Promise<VerifyCheck[]> {
  const source = entry.source
  if (source.kind !== "agentapp") throw new Error("not an agentapp entry")
  const checks: VerifyCheck[] = []

  if (source.size !== undefined) {
    const size = (await stat(bundle)).size
    checks.push(check("size", size === source.size, `bundle is ${size} bytes, source.size says ${source.size}`))
  } else {
    checks.push(check("size", true, "no source.size declared; skipped"))
  }

  let manifest: { sha256: string; id: string; version: string }
  const dest = await mkdtemp(join(tmpdir(), "catalog-verify-"))
  try {
    const unpacked = await unpackApp({ file: bundle, dest })
    manifest = unpacked.manifest
    checks.push(
      check(
        "sha256",
        manifest.sha256.toLowerCase() === source.sha256.toLowerCase(),
        `manifest ${manifest.sha256} vs source ${source.sha256} (unpack also verifies the aggregate over every file)`,
      ),
    )

    const appMdPath = join(dest, ".agentproto", "APP.md")
    const front = matter(await readFile(appMdPath, "utf8")).data as Record<string, unknown>
    const id = typeof front.id === "string" ? front.id : undefined
    const version = typeof front.version === "string" ? front.version : undefined
    const ui = front.ui
    const hasBuild =
      ui !== null && typeof ui === "object" && !Array.isArray(ui) && "build" in (ui as Record<string, unknown>)
    checks.push(check("app-id", id === entry.appId, `APP.md id is ${id ?? "absent"}, entry appId is ${entry.appId}`))
    checks.push(
      check("app-version", version === source.version, `APP.md version is ${version ?? "absent"}, source.version is ${source.version}`),
    )
    checks.push(check("no-ui-build", !hasBuild, "a published bundle must not carry a ui.build step"))

    const validate = await collectAppFindings(dest)
    const errorFindings = validate.findings.filter((f) => f.level === "error")
    checks.push(
      check(
        "app-validate",
        errorFindings.length === 0,
        errorFindings.length === 0
          ? undefined
          : errorFindings.map((f) => `${f.scope}: ${f.message}`).join("; "),
      ),
    )
  } finally {
    await rm(dest, { recursive: true, force: true })
  }
  return checks
}

/** Parse `--offline-file` style is handled in runCatalog; here: run the
 *  full verify for one entry. */
type LocalMedia = ReadonlyArray<{ prefix: string; dir: string }>

/** Bytes of a listing media URL: from a `--local-media` directory when the
 *  URL is under its prefix (media added by the PR under review, not yet on
 *  the default branch), else downloaded over https with a size cap. */
async function readMedia(url: string, localMedia: LocalMedia, maxBytes: number): Promise<Uint8Array> {
  for (const { prefix, dir } of localMedia) {
    if (url.startsWith(prefix)) {
      const rel = decodeURIComponent(url.slice(prefix.length))
      const path = resolve(dir, rel)
      if (!path.startsWith(dir.endsWith(sep) ? dir : dir + sep)) throw new Error(`${url} escapes ${dir}`)
      return new Uint8Array(await readFile(path))
    }
  }
  if (!/^https:\/\//i.test(url)) throw new Error(`${url} is not https`)
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "follow" })
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`)
  const declared = Number(res.headers.get("content-length") ?? "0")
  // Read a little past the cap so an oversized file is reported, not truncated.
  if (declared > maxBytes + 1) throw new Error(`${url} is ${declared} bytes, over the ${maxBytes} byte cap`)
  return new Uint8Array(await res.arrayBuffer())
}

/** The entry's store listing: field limits, then each icon/screenshot's
 *  format and size. Entries without listing fields pass trivially. */
async function verifyListing(entry: AppCatalogEntry, localMedia: LocalMedia): Promise<VerifyCheck[]> {
  const issues = listingIssues(entry)
  const checks = [check("listing", issues.length === 0, issues.join("; ") || undefined)]
  const media: Array<{ url: string; kind: "icon" | "screenshot"; label: string }> = [
    ...(entry.icon !== undefined && /^https:\/\//i.test(entry.icon) ? [{ url: entry.icon, kind: "icon" as const, label: "icon" }] : []),
    ...(entry.screenshots ?? [])
      .filter((s) => /^https:\/\//i.test(s.url))
      .map((s, i) => ({ url: s.url, kind: "screenshot" as const, label: `screenshots[${i}]` })),
  ]
  if (media.length === 0) return checks
  const problems: string[] = []
  for (const m of media) {
    const cap = m.kind === "icon" ? CATALOG_LISTING_LIMITS.iconMaxBytes : CATALOG_LISTING_LIMITS.screenshotMaxBytes
    try {
      problems.push(...checkMediaBytes(await readMedia(m.url, localMedia, cap), m.kind, m.label))
    } catch (err) {
      problems.push(`${m.label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  checks.push(
    check(
      "media",
      problems.length === 0,
      problems.length === 0 ? `${media.length} file(s) checked` : problems.join("; "),
    ),
  )
  return checks
}

async function verifyEntry(
  entry: AppCatalogEntry,
  file: string,
  opts: { offline: Map<string, string>; localMedia: LocalMedia; allowGit: boolean },
): Promise<VerifyReport> {
  const checks: VerifyCheck[] = []
  try {
    checks.push(...(await verifyListing(entry, opts.localMedia)))
    if (entry.source.kind === "git") {
      checks.push(
        opts.allowGit
          ? check("source-kind", true, "git source allowed with --allow-git; bundle checks skipped")
          : check("source-kind", false, 'git sources are not accepted in the public catalog (bundles only); use --allow-git to override'),
      )
    } else if (entry.source.kind !== "agentapp") {
      checks.push(check("source-kind", false, `source.kind "${entry.source.kind}" is not verifiable here`))
    } else {
      checks.push(...okChecks("schema", "source-kind"))
      const url = entry.source.url
      let bundle: string | undefined
      let bundleDir: string | undefined
      const offlinePath = opts.offline.get(entry.appId)
      if (offlinePath !== undefined) {
        bundle = offlinePath
        checks.push(check("download", true, `offline-file substituted for ${url}`))
      } else {
        if (!/^https:\/\//i.test(url)) {
          checks.push(check("download", false, `source.url must be https:// (got "${url}")`))
          return { appId: entry.appId, file, ok: false, checks }
        }
        bundleDir = await mkdtemp(join(tmpdir(), "catalog-verify-dl-"))
        bundle = join(bundleDir, "bundle.agentapp")
        try {
          await downloadTo(url, bundle)
          checks.push(check("download", true))
        } catch (err) {
          checks.push(check("download", false, err instanceof Error ? err.message : String(err)))
          return { appId: entry.appId, file, ok: false, checks }
        }
      }
      try {
        checks.push(...(await verifyBundleOnDisk(bundle, entry)))
      } finally {
        if (bundleDir !== undefined) await rm(bundleDir, { recursive: true, force: true })
      }
    }
  } catch (err) {
    checks.push(check("verify", false, err instanceof Error ? err.message : String(err)))
  }
  return { appId: entry.appId, file, ok: checks.every((c) => c.ok), checks }
}

/** `agentproto catalog verify ...` */
async function runCatalogVerify(
  args: readonly string[],
  opts: { offline: Map<string, string>; localMedia: LocalMedia; json: boolean; allowGit: boolean },
): Promise<number> {
  let paths: string[]
  try {
    paths = await collectEntryPaths(args)
  } catch (err) {
    process.stderr.write(`agentproto catalog verify: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  const reports: VerifyReport[] = []
  for (const p of paths) {
    let entry: AppCatalogEntry
    try {
      entry = await readEntry(p)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      reports.push({ appId: "?", file: p, ok: false, checks: [check("schema", false, message)] })
      if (opts.json) break
      process.stderr.write(`agentproto catalog verify: FAIL ${message}\n`)
      return 1
    }
    const report = await verifyEntry(entry, p, opts)
    reports.push(report)
    if (!report.ok && !opts.json) {
      // Stop at the first failing entry; print the report collected so far.
      printVerifyReports(reports)
      process.stderr.write(`agentproto catalog verify: FAILED (${report.appId})\n`)
      return 1
    }
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ ok: reports.every((r) => r.ok), entries: reports }, null, 2) + "\n",
    )
    return reports.every((r) => r.ok) ? 0 : 1
  }

  printVerifyReports(reports)
  const failed = reports.filter((r) => !r.ok).length
  if (failed > 0) {
    process.stderr.write(`agentproto catalog verify: ${failed} of ${reports.length} entr${reports.length === 1 ? "y" : "ies"} failed.\n`)
    return 1
  }
  process.stdout.write(`agentproto catalog verify: ${reports.length} entr${reports.length === 1 ? "y" : "ies"} verified.\n`)
  return 0
}

function printVerifyReports(reports: readonly VerifyReport[]): void {
  for (const r of reports) {
    process.stdout.write(`${r.ok ? "ok  " : "FAIL"} ${r.appId} (${r.file})\n`)
    for (const c of r.checks) {
      const line = `  [${c.ok ? "ok" : "FAIL"}] ${c.name}${c.detail !== undefined ? `: ${c.detail}` : ""}`
      if (c.ok) process.stdout.write(line + "\n")
      else process.stderr.write(line + "\n")
    }
  }
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
      json: { type: "boolean" },
      "allow-git": { type: "boolean" },
    },
  })
  return { values: values as Record<string, string | boolean | undefined>, positionals }
}
