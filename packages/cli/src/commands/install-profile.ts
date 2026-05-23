/**
 * `agentproto install runtime-profile/<name>` — copy a declared file
 * tree from `@agentproto/runtime-profile-<name>` into the user's repo.
 *
 * Source of truth: the profile package's `profile.json` manifest +
 * `files/` tree. The handler is dumb on purpose — it copies declared
 * files with per-entry merge strategies and records what landed in a
 * local ledger so re-runs can be idempotent and detect drift.
 */

import { readFile, writeFile, mkdir, stat, chmod } from "node:fs/promises"
import { dirname, resolve as resolvePath, join } from "node:path"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { parseArgs } from "node:util"

type Strategy = "overwrite" | "preserve" | "merge-json-deep" | "append"

type ProfileFile = {
  src: string
  dest: string
  strategy: Strategy
  executable?: boolean
}

type ProfileManifest = {
  schema: string
  slug: string
  version: string
  name: string
  description: string
  files: ProfileFile[]
}

type LedgerEntry = {
  dest: string
  strategy: Strategy
  hashAfter: string
  appliedAt: string
}

type Ledger = {
  slug: string
  version: string
  installedAt: string
  updatedAt: string
  files: LedgerEntry[]
}

export async function runInstallProfile(
  slug: string,
  args: readonly string[]
): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      force: { type: "boolean", short: "f" },
      "dry-run": { type: "boolean" },
      "skip-setup": { type: "boolean" },
      cwd: { type: "string" },
      package: { type: "string" },
    },
  })

  if (!slug.startsWith("runtime-profile/")) {
    process.stderr.write(
      `agentproto install: expected slug starting with 'runtime-profile/', got '${slug}'.\n`
    )
    return 2
  }
  const profileName = slug.slice("runtime-profile/".length)
  if (!/^[a-z][a-z0-9-]*$/.test(profileName)) {
    process.stderr.write(
      `agentproto install: invalid profile name '${profileName}'. Lower-kebab only.\n`
    )
    return 2
  }

  // Resolution order for the backing npm package:
  //   1. Explicit `--package <name>` override.
  //   2. `profileAliases[<slug>]` in `~/.agentproto/config.json`.
  //   3. Default convention: `@agentproto/runtime-profile-<slug>`.
  let packageName: string
  if (typeof values.package === "string" && values.package) {
    packageName = values.package
  } else {
    const aliased = await readProfileAlias(profileName)
    packageName = aliased ?? `@agentproto/runtime-profile-${profileName}`
  }
  let mod: Record<string, unknown>
  try {
    mod = (await import(packageName)) as Record<string, unknown>
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `agentproto install: could not load profile package '${packageName}'. Install it first with: npm i -g ${packageName}\n  cause: ${cause}\n`
    )
    return 1
  }
  const filesDir =
    typeof mod.FILES_DIR === "string" ? (mod.FILES_DIR as string) : null
  const loadProfileManifest = mod.loadProfileManifest as
    | (() => Promise<ProfileManifest>)
    | undefined
  if (!filesDir || !loadProfileManifest) {
    process.stderr.write(
      `agentproto install: profile package '${packageName}' does not export FILES_DIR + loadProfileManifest.\n`
    )
    return 1
  }

  const manifest = await loadProfileManifest()

  const cwd = values.cwd ? resolvePath(values.cwd) : process.cwd()
  const dryRun = values["dry-run"] === true
  const force = values.force === true

  process.stdout.write(
    `agentproto install ${slug} v${manifest.version} → ${cwd}\n` +
      `  ${manifest.description}\n`
  )

  const ledgerPath = ledgerPathFor(profileName)
  const prevLedger = await loadLedger(ledgerPath)

  const newLedger: Ledger = {
    slug,
    version: manifest.version,
    installedAt: prevLedger?.installedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    files: [],
  }

  let applied = 0
  let skipped = 0
  let failed = 0

  for (const entry of manifest.files) {
    const src = resolvePath(filesDir, entry.src)
    const dest = resolvePath(cwd, entry.dest)
    const prev = prevLedger?.files.find((f) => f.dest === entry.dest) ?? null

    try {
      const srcBuf = await readFile(src)
      const result = await applyStrategy({
        strategy: entry.strategy,
        srcBuf,
        dest,
        prev,
        force,
        dryRun,
      })
      newLedger.files.push({
        dest: entry.dest,
        strategy: entry.strategy,
        hashAfter: result.hashAfter,
        appliedAt: result.wrote ? new Date().toISOString() : prev?.appliedAt ?? new Date().toISOString(),
      })
      if (result.wrote) {
        applied += 1
        process.stdout.write(`  ${result.action.padEnd(10)} ${entry.dest}\n`)
        if (entry.executable && !dryRun) {
          await chmod(dest, 0o755)
        }
      } else {
        skipped += 1
        process.stdout.write(`  ${result.action.padEnd(10)} ${entry.dest}\n`)
      }
    } catch (err) {
      failed += 1
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`  FAIL       ${entry.dest} — ${msg}\n`)
    }
  }

  if (!dryRun) {
    await saveLedger(ledgerPath, newLedger)
  }

  process.stdout.write(
    `agentproto install ${slug}: ${applied} applied, ${skipped} skipped, ${failed} failed${dryRun ? " (dry-run)" : ""}\n`
  )

  return failed === 0 ? 0 : 1
}

type ApplyResult = {
  wrote: boolean
  action: string
  hashAfter: string
}

async function applyStrategy(opts: {
  strategy: Strategy
  srcBuf: Buffer
  dest: string
  prev: LedgerEntry | null
  force: boolean
  dryRun: boolean
}): Promise<ApplyResult> {
  const { strategy, srcBuf, dest, prev, force, dryRun } = opts

  const destExists = await fileExists(dest)

  if (strategy === "preserve") {
    if (destExists) {
      const currentHash = await hashFile(dest)
      return { wrote: false, action: "preserve", hashAfter: currentHash }
    }
    if (!dryRun) {
      await ensureDir(dirname(dest))
      await writeFile(dest, srcBuf)
    }
    return { wrote: true, action: "create", hashAfter: sha256(srcBuf) }
  }

  if (strategy === "overwrite") {
    const srcHash = sha256(srcBuf)
    if (destExists && !force) {
      const destHash = await hashFile(dest)
      if (destHash === srcHash) {
        return { wrote: false, action: "unchanged", hashAfter: destHash }
      }
      if (prev && prev.hashAfter !== destHash) {
        // The user edited this file after our last install. Don't
        // clobber without --force.
        return {
          wrote: false,
          action: "user-edit",
          hashAfter: destHash,
        }
      }
    }
    if (!dryRun) {
      await ensureDir(dirname(dest))
      await writeFile(dest, srcBuf)
    }
    return {
      wrote: true,
      action: destExists ? "update" : "create",
      hashAfter: srcHash,
    }
  }

  if (strategy === "merge-json-deep") {
    const srcJson = parseJsonOrThrow(srcBuf.toString("utf8"), "src")
    let merged: unknown = srcJson
    if (destExists) {
      const destRaw = await readFile(dest, "utf8")
      const destJson = parseJsonOrThrow(destRaw, "dest")
      merged = deepMerge(destJson, srcJson)
    }
    const out = `${JSON.stringify(merged, null, 2)}\n`
    const outBuf = Buffer.from(out, "utf8")
    const outHash = sha256(outBuf)
    if (destExists) {
      const destHash = await hashFile(dest)
      if (destHash === outHash) {
        return { wrote: false, action: "unchanged", hashAfter: destHash }
      }
    }
    if (!dryRun) {
      await ensureDir(dirname(dest))
      await writeFile(dest, outBuf)
    }
    return {
      wrote: true,
      action: destExists ? "merge" : "create",
      hashAfter: outHash,
    }
  }

  if (strategy === "append") {
    const srcText = srcBuf.toString("utf8")
    if (destExists) {
      const destText = await readFile(dest, "utf8")
      if (destText.includes(srcText)) {
        return {
          wrote: false,
          action: "unchanged",
          hashAfter: sha256(Buffer.from(destText, "utf8")),
        }
      }
      const out = `${destText.endsWith("\n") ? destText : `${destText}\n`}${srcText}`
      const outBuf = Buffer.from(out, "utf8")
      if (!dryRun) {
        await ensureDir(dirname(dest))
        await writeFile(dest, outBuf)
      }
      return { wrote: true, action: "append", hashAfter: sha256(outBuf) }
    }
    if (!dryRun) {
      await ensureDir(dirname(dest))
      await writeFile(dest, srcBuf)
    }
    return { wrote: true, action: "create", hashAfter: sha256(srcBuf) }
  }

  throw new Error(`Unknown strategy: ${strategy}`)
}

function deepMerge(target: unknown, source: unknown): unknown {
  if (
    target &&
    source &&
    typeof target === "object" &&
    typeof source === "object" &&
    !Array.isArray(target) &&
    !Array.isArray(source)
  ) {
    const out: Record<string, unknown> = { ...(target as Record<string, unknown>) }
    for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
      out[k] = deepMerge((target as Record<string, unknown>)[k], v)
    }
    return out
  }
  if (Array.isArray(target) && Array.isArray(source)) {
    // Concat + dedup-by-JSON. Cheap and safe for hook arrays and
    // permission lists (which are the realistic merge targets).
    const seen = new Set<string>()
    const out: unknown[] = []
    for (const item of [...target, ...source]) {
      const key = JSON.stringify(item)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
    return out
  }
  return source ?? target
}

function parseJsonOrThrow(raw: string, side: "src" | "dest"): unknown {
  try {
    return JSON.parse(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`merge-json-deep ${side} not valid JSON: ${msg}`)
  }
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex")
}

async function hashFile(path: string): Promise<string> {
  const buf = await readFile(path)
  return sha256(buf)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await stat(dir)
  } catch {
    await mkdir(dir, { recursive: true })
  }
}

function ledgerPathFor(profileName: string): string {
  return join(homedir(), ".agentproto", "profiles", `${profileName}.json`)
}

async function loadLedger(path: string): Promise<Ledger | null> {
  try {
    const raw = await readFile(path, "utf8")
    return JSON.parse(raw) as Ledger
  } catch {
    return null
  }
}

async function saveLedger(path: string, ledger: Ledger): Promise<void> {
  await ensureDir(dirname(path))
  await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`)
}

/**
 * Look up a profile-slug → npm-package alias in
 * `~/.agentproto/config.json` (or `$AGENTPROTO_HOME/config.json`).
 *
 *   { "profileAliases": { "guilde": "@guilde/runtime-profile-guilde" } }
 *
 * Returns the resolved package name, or `null` if no alias is set.
 */
async function readProfileAlias(profileName: string): Promise<string | null> {
  const base =
    process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
  const path = join(base, "config.json")
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as {
      profileAliases?: Record<string, string>
    }
    const aliased = parsed.profileAliases?.[profileName]
    return typeof aliased === "string" ? aliased : null
  } catch {
    return null
  }
}
