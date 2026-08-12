/**
 * `agentproto app pack <appDir> [--out <path.agentapp>] [--json]`
 * `agentproto app unpack <file.agentapp> [--dir <outDir>] [--json]`
 *
 * Package an agentproto app folder (one holding a valid `.agentproto/APP.md`)
 * into a single self-contained `.agentapp` tar.gz bundle — the "APK for
 * agentproto apps" — and unpack that bundle back into a folder, verifying
 * the aggregate SHA-256 before restoring. This file also dispatches `app
 * serve` (`../app-serve.ts`), `app build` (`../app-build.ts`), and `app dev`
 * (`../app-dev.ts`) — pack/unpack are the only sub-verbs implemented here.
 *
 * PACK   walks the entire app dir (including `.agentproto/`, but skipping
 *        any `node_modules/` or `.git/` at any depth — a `ui/` source tree
 *        ships both and neither belongs in the shipped app), writes a
 *        `manifest.json` at the bundle root, and tars the app folder's
 *        CONTENTS (not the folder itself) with system `tar`, so extraction
 *        yields `manifest.json` + `.agentproto/` + loose files at the top
 *        level and relative paths survive round-tripping (`readAppRefs`
 *        resolves after unpack).
 *
 * UNPACK extracts to a fresh temp dir, reads `manifest.json`, validates
 *        `format === "agentapp/v1"`, recomputes the aggregate SHA over the
 *        listed files and compares it to `manifest.sha256`, then moves the
 *        restored contents (WITHOUT `manifest.json` — it is a bundle
 *        artifact, not part of the app) into the destination dir.
 *
 * The SHA is over file contents ONLY (excluding manifest.json), fed in the
 * manifest `files` order (pack already sorts them), accumulated into one
 * hasher so bundling-scale trees don't load into memory.
 */

import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { parseArgs } from "node:util"

import matter from "gray-matter"
import { pathExists } from "./skill-install/shared.js"
import { expandHome } from "./skill-install/pack-resolve.js"
import { runAppServe } from "../app-serve.js"
import { runAppBuild } from "../app-build.js"
import { runAppDev } from "../app-dev.js"

// ── types ────────────────────────────────────────────────────────────────

const FORMAT = "agentapp/v1" as const
const DEFAULT_VERSION = "0.1.0"

/** Directory names skipped at any depth while walking/copying an app dir. */
const SKIP_DIR_NAMES = new Set(["node_modules", ".git"])

/** `.agentproto/APP.md` frontmatter, digested into bundle metadata. */
interface AppMeta {
  id: string
  name?: string
  version: string
  description?: string
  agents: string[]
  workflows: string[]
  ui?: string[]
  artifacts?: string[]
  skills?: string[]
}

/** A file discovered under the app dir, with its size for the manifest. */
interface BundleFile {
  path: string
  size: number
}

/** The manifest.json written at the bundle root (and validated on unpack). */
interface AgentAppManifest {
  format: typeof FORMAT
  id: string
  name?: string
  version: string
  description?: string
  agents: string[]
  workflows: string[]
  ui?: string[]
  files: string[]
  fileCount: number
  totalSize: number
  sha256: string
  createdAt: string
  agentprotoVersion: string
}

const USAGE = `agentproto app — package, unpack, serve, build, or dev an agentproto app

Usage:
  agentproto app pack <appDir> [--out <path.agentapp>] [--json]
  agentproto app unpack <file.agentapp> [--dir <outDir>] [--json]
  agentproto app serve [appDir] [--port <n>] [--json]
  agentproto app build <appDir> [--json]
  agentproto app dev <appDir> [--port <n>] [--json] [-- <viteArgs...>]

pack:
  Walk <appDir> (must contain .agentproto/APP.md), write manifest.json and a
  sha256 aggregate over every file, and emit a verified .agentapp tar.gz.
  Without --out, derives <id>-<version>.agentapp in the current directory.
  Skips any node_modules/ or .git/ directory at any depth.

unpack:
  Extract a .agentapp, verify format agentapp/v1 and the sha256 aggregate,
  and restore the app folder (without manifest.json). Without --dir,
  restores into <id>-<version> in the current directory.

serve:
  Serve <appDir>'s .agentproto/ui/ as a standalone webapp with a window.McpApp
  bridge wired to the daemon's /mcp endpoint. Port resolution: --port, then
  the APP.md "ui.port" hint, then an OS-assigned free port.

build:
  Build <appDir>/ui/ (a Vite UI source project) into .agentproto/ui/. No
  ui/ project, or one with no "scripts.build", is a no-op success — the app
  is a hand-written static UI with nothing to compile.

dev:
  Run <appDir>/ui/'s own dev server with a live window.McpApp bridge (a
  bridge-only HTTP server, CORS-enabled, separate from the Vite dev port).
  Requires ui/package.json with a "scripts.dev"; static UIs use app serve.`

// ── public entries ───────────────────────────────────────────────────────

/** Dispatcher for `agentproto app` — first non-flag token is the subverb. */
export async function runApp(args: readonly string[]): Promise<number> {
  const subVerb = args.find((a) => !a.startsWith("-"))
  if (subVerb === "pack") {
    return runAppPack(args.filter((a) => a !== subVerb))
  }
  if (subVerb === "unpack") {
    return runAppUnpack(args.filter((a) => a !== subVerb))
  }

  if (subVerb === "serve") {
    return runAppServe(args.filter((a) => a !== subVerb))
  }
  if (subVerb === "build") {
    return runAppBuild(args.filter((a) => a !== subVerb))
  }
  if (subVerb === "dev") {
    return runAppDev(args.filter((a) => a !== subVerb))
  }

  process.stderr.write(
    `agentproto app: unknown sub-command${subVerb ? ` '${subVerb}'` : ""}.\n` +
      `${USAGE}\n`,
  )
  return 2
}

/** `agentproto app pack <appDir> [--out ...] [--json]`. */
export async function runAppPack(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options: {
      out: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  })

  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const appDir = positionals[0]
  if (!appDir) {
    process.stderr.write(
      `agentproto app pack: <appDir> is required.\n${USAGE}\n`,
    )
    return 2
  }

  const appDirAbs = resolve(process.cwd(), expandHome(appDir))

  // 1. Require a valid .agentproto/APP.md
  const appMdPath = join(appDirAbs, ".agentproto", "APP.md")
  if (!(await pathExists(appMdPath))) {
    process.stderr.write(
      `agentproto app pack: ${appDirAbs} is not an agentproto app ` +
        `(missing ${appMdPath}).\n`,
    )
    return 2
  }

  // 2. Parse APP.md frontmatter -> metadata
  const raw = await readFile(appMdPath, "utf8")
  const front = matter(raw).data as Record<string, unknown>
  const meta = extractMeta(front)

  // 7. Resolve the output path (needs id/version for the default filename)
  const outAbs = typeof values.out === "string"
    ? resolve(process.cwd(), expandHome(values.out))
    : resolve(
        process.cwd(),
        `${safeId(meta.id)}-${meta.version}.agentapp`,
      )
  await mkdir(dirname(outAbs), { recursive: true })

  // 3. Walk the whole appDir, sort, skip bundle artifacts
  let files = await collectFiles(appDirAbs)
  files = files
    .filter((f) => f.path !== "manifest.json")
    .filter((f) => join(appDirAbs, f.path) !== outAbs)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const fileCount = files.length
  const totalSize = files.reduce((sum, f) => sum + f.size, 0)

  // 4. Aggregate sha256 over the concatenated bytes, in sorted order
  const sha256 = await aggregateSha256(
    appDirAbs,
    files.map((f) => f.path),
  )

  // 5. Build manifest.json exactly as specced (omit undefined fields)
  const manifest: AgentAppManifest = {
    format: FORMAT,
    id: meta.id,
    ...(meta.name !== undefined ? { name: meta.name } : {}),
    version: meta.version,
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    agents: meta.agents,
    workflows: meta.workflows,
    ...(meta.ui !== undefined ? { ui: meta.ui } : {}),
    files: files.map((f) => f.path),
    fileCount,
    totalSize,
    sha256,
    createdAt: new Date().toISOString(),
    agentprotoVersion: ">=0.1.0",
  }

  // 6. Stage: copy contents into a temp dir, write manifest.json, tar it.
  // The filter also enforces the node_modules/.git exclusion on the actual
  // bundle contents (collectFiles above only shaped the manifest's `files`
  // list) — cp() skips a filtered-out directory's contents entirely rather
  // than recursing into it.
  const staging = await mkdtemp(join(tmpdir(), "agentapp-"))
  try {
    await cp(appDirAbs, staging, {
      recursive: true,
      filter: (source) => !SKIP_DIR_NAMES.has(basename(source)),
    })
    await writeFile(
      join(staging, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    )
    // Offline-deterministic archive: pass the entry list explicitly (sorted) so
    // the archive order is reproducible without GNU-only `--sort=name`, which
    // BSD/macOS tar rejects. Dotfiles (`.agentproto`) are included by readdir.
    const entries = (await readdir(staging)).sort()
    const packCode = await runTar(
      ["-czf", outAbs, ...entries],
      { cwd: staging },
    )
    if (packCode !== 0) {
      process.stderr.write(`agentproto app pack: tar failed with exit code ${packCode}
`)
      return 1
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }

  // 8. Report
  if (values.json) {
    process.stdout.write(JSON.stringify(manifest, null, 2) + "\n")
  } else {
    process.stdout.write(`agentproto: packed ${totalSize} bytes -> ${outAbs}\n`)
  }
  return 0
}

/** `agentproto app unpack <file.agentapp> [--dir ...] [--json]`. */
export async function runAppUnpack(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options: {
      dir: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  })

  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const fileArg = positionals[0]
  if (!fileArg) {
    process.stderr.write(
      `agentproto app unpack: <file.agentapp> is required.\n${USAGE}\n`,
    )
    return 2
  }

  const bundleAbs = resolve(process.cwd(), expandHome(fileArg))

  // 1. Bundle must exist
  if (!(await pathExists(bundleAbs))) {
    process.stderr.write(
      `agentproto app unpack: bundle not found: ${bundleAbs}\n`,
    )
    return 2
  }

  // 2a. Extract to a fresh temp dir, read manifest.json there
  const temp = await mkdtemp(join(tmpdir(), "agentapp-"))
  let manifest: AgentAppManifest
  try {
    const unpackCode = await runTar(["-xzf", bundleAbs, "-C", temp])
    if (unpackCode !== 0) {
      process.stderr.write(`agentproto app unpack: tar failed with exit code ${unpackCode}
`)
      return 1
    }

    // 2c. manifest.json is required
    const manifestPath = join(temp, "manifest.json")
    if (!(await pathExists(manifestPath))) {
      process.stderr.write(
        `agentproto app unpack: ${bundleAbs} is not a valid .agentapp (missing manifest.json).\n`,
      )
      return 1
    }
    const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"))
    if (!isManifest(parsed)) {
      process.stderr.write(
        `agentproto app unpack: ${bundleAbs} has a malformed manifest.json.\n`,
      )
      return 1
    }
    manifest = parsed

    // 2d. format must be agentapp/v1
    if (manifest.format !== FORMAT) {
      process.stderr.write(
        `agentproto app unpack: unsupported bundle format '${manifest.format}' ` +
          `(expected ${FORMAT}).\n`,
      )
      return 1
    }

    // 2e. Recompute the aggregate sha over every listed file -> compare
    const actual = await aggregateSha256(temp, manifest.files)
    if (actual !== manifest.sha256) {
      process.stderr.write(
        `agentproto app unpack: SHA-256 mismatch (expected ${manifest.sha256}, ` +
          `got ${actual}). Bundle is corrupted.\n`,
      )
      return 1
    }

    // 2f. Restore contents WITHOUT manifest.json into the destination
    const outDir = typeof values.dir === "string"
      ? resolve(process.cwd(), expandHome(values.dir))
      : resolve(process.cwd(), `${safeId(manifest.id)}-${manifest.version}`)
    // Drop the bundle artifact before moving the app contents over.
    await rm(manifestPath, { force: true })
    await mkdir(outDir, { recursive: true })
    await cp(temp, outDir, { recursive: true })

    // 3. Report
    if (values.json) {
      process.stdout.write(
        JSON.stringify(
          {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            fileCount: manifest.fileCount,
            outDir,
            sha256: manifest.sha256,
            verified: true,
          },
          null,
          2,
        ) + "\n",
      )
    } else {
      const label = manifest.name !== undefined ? ` (${manifest.name})` : ""
      process.stdout.write(
        `agentproto: unpacked ${manifest.id}${label} v${manifest.version} -> ${outDir}\n` +
          `  ${manifest.fileCount} file(s), sha256 verified (${manifest.sha256.slice(0, 12)}...)\n`,
      )
    }
  } catch (err) {
    process.stderr.write(
      `agentproto app unpack: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  } finally {
    await rm(temp, { recursive: true, force: true })
  }

  return 0
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Derive a filesystem-safe id from a possibly scoped/odd app id. */
function safeId(id: unknown): string {
  return String(id || "app").replace(/^@/, "").replace(/[^A-Za-z0-9._-]+/g, "-")
}

/** Extract bundle metadata from APP.md frontmatter. */
function extractMeta(front: Record<string, unknown>): AppMeta {
  const id =
    typeof front.id === "string" && front.id.length > 0
      ? front.id
      : typeof front.slug === "string" && front.slug.length > 0
        ? front.slug
        : "app"
  const version =
    typeof front.version === "string" && front.version.length > 0
      ? front.version
      : DEFAULT_VERSION
  const name = typeof front.name === "string" ? front.name : undefined
  const description =
    typeof front.description === "string" ? front.description : undefined

  return {
    id,
    ...(name !== undefined ? { name } : {}),
    version,
    ...(description !== undefined ? { description } : {}),
    agents: extractIds(front.agents),
    workflows: extractIds(front.workflows),
    ...withPaths(extractPaths(front, "ui"), "ui"),
    ...withPaths(extractPaths(front, "artifact"), "artifacts"),
    ...withPaths(extractPaths(front, "skill"), "skills"),
  }
}

/** Pull ids from an `[{id, path}]` (or bare-string) array. */
function extractIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry === "string") {
      if (entry) out.push(entry)
    } else if (entry && typeof entry === "object") {
      const id = (entry as { id?: unknown }).id
      if (typeof id === "string" && id) out.push(id)
    }
  }
  return out
}

/** Spread a paths-array into `{ [key]: [...] }` only when present. */
function withPaths(
  paths: string[] | undefined,
  key: string,
): Record<string, string[]> {
  return paths !== undefined ? { [key]: paths } : {}
}

/** Basenames for a path/`{path}`/array-of-either frontmatter field. */
function extractPaths(
  front: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = front[key]
  if (value === undefined || value === null) return undefined
  const items = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const item of items) {
    if (typeof item === "string") {
      if (item) out.push(basename(item))
    } else if (item && typeof item === "object") {
      const p = (item as { path?: unknown }).path
      if (typeof p === "string" && p) out.push(basename(p))
    }
  }
  return out.length > 0 ? out : undefined
}

/**
 * Recursively collect every regular file under root as relative paths,
 * skipping any `node_modules/` or `.git/` directory at any depth — a `ui/`
 * source tree ships both, and bundling either would balloon the .agentapp
 * for no benefit (they're never part of the shipped app).
 */
async function collectFiles(root: string): Promise<BundleFile[]> {
  const files: BundleFile[] = []
  async function walk(relDir: string): Promise<void> {
    const absDir = join(root, relDir)
    for (const entry of await readdir(absDir, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) continue
      const rel = relDir ? join(relDir, entry.name) : entry.name
      const abs = join(absDir, entry.name)
      if (entry.isDirectory()) {
        await walk(rel)
      } else if (entry.isFile()) {
        const st = await stat(abs)
        files.push({ path: rel, size: st.size })
      }
    }
  }
  await walk("")
  return files
}

/**
 * Run system `tar` with the given args, resolving the exit code (0 = ok).
 * Uses `spawn` + an exit handler rather than the callback-`execFile` form so
 * the awaited promise actually tracks process completion cross-platform
 * (BSD/macOS and GNU tar). Mirrors `runTarExtract` in fetch-pack.ts.
 */
function runTar(
  args: string[],
  opts?: { cwd?: string },
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("tar", args, { stdio: "ignore", cwd: opts?.cwd })
    child.once("error", reject)
    child.once("exit", (code) => resolvePromise(code ?? 0))
  })
}

/** Aggregate sha256 over the concatenated bytes of the given files. */
async function aggregateSha256(
  root: string,
  files: string[],
): Promise<string> {
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(await readFile(join(root, file)))
  }
  return hash.digest("hex")
}

/** Narrow an unknown parsed JSON value to the manifest shape. */
function isManifest(value: unknown): value is AgentAppManifest {
  if (typeof value !== "object" || value === null) return false
  const m = value as Record<string, unknown>
  return (
    typeof m.format === "string" &&
    typeof m.id === "string" &&
    typeof m.version === "string" &&
    Array.isArray(m.agents) &&
    Array.isArray(m.workflows) &&
    Array.isArray(m.files) &&
    typeof m.fileCount === "number" &&
    typeof m.totalSize === "number" &&
    typeof m.sha256 === "string"
  )
}
