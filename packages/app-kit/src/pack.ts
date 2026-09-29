/**
 * `.agentapp` pack / unpack core (AIP-53 §"The `.agentapp` package format").
 *
 * PACK   walks the entire app dir (including `.agentproto/`, but skipping
 *        any `node_modules/` or `.git/` at any depth — a `ui/` source tree
 *        ships both and neither belongs in the shipped app), writes a
 *        `manifest.json` at the bundle root, and tars the app folder's
 *        CONTENTS (not the folder itself) with system `tar`, so extraction
 *        yields `manifest.json` + `.agentproto/` + loose files at the top
 *        level and relative paths survive round-tripping.
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
 *
 * Both entries throw {@link AgentAppPackError}; `code` lets a caller (the
 * CLI, the daemon's remote install) map failures without parsing messages.
 */

import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"

import matter from "gray-matter"

export const AGENTAPP_FORMAT = "agentapp/v1" as const
const DEFAULT_VERSION = "0.1.0"

/** Directory names skipped at any depth while walking/copying an app dir. */
const SKIP_DIR_NAMES = new Set(["node_modules", ".git"])

/** The manifest.json written at the bundle root (and validated on unpack). */
export interface AgentAppManifest {
  format: typeof AGENTAPP_FORMAT
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

/** A file discovered under the app dir, with its size for the manifest. */
export interface BundleFile {
  path: string
  size: number
}

export type AgentAppPackErrorCode =
  | "not-an-app"
  | "bundle-not-found"
  | "tar-failed"
  | "missing-manifest"
  | "malformed-manifest"
  | "unsupported-format"
  | "unsafe-path"
  | "digest-mismatch"

export class AgentAppPackError extends Error {
  readonly code: AgentAppPackErrorCode
  constructor(code: AgentAppPackErrorCode, message: string) {
    super(message)
    this.name = "AgentAppPackError"
    this.code = code
  }
}

/** `.agentproto/APP.md` frontmatter, digested into bundle metadata. */
interface AppMeta {
  id: string
  name?: string
  version: string
  description?: string
  agents: string[]
  workflows: string[]
  ui?: string[]
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** Derive a filesystem-safe id from a possibly scoped/odd app id. */
export function safeId(id: unknown): string {
  return String(id || "app").replace(/^@/, "").replace(/[^A-Za-z0-9._-]+/g, "-")
}

/** Narrow an unknown parsed JSON value to the manifest shape. */
export function isManifest(value: unknown): value is AgentAppManifest {
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

/**
 * Recursively collect every regular file under root as relative paths,
 * skipping any `node_modules/` or `.git/` directory at any depth — a `ui/`
 * source tree ships both, and bundling either would balloon the .agentapp
 * for no benefit (they're never part of the shipped app).
 */
export async function collectFiles(root: string): Promise<BundleFile[]> {
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

/** Aggregate sha256 over the concatenated bytes of the given files. */
export async function aggregateSha256(root: string, files: readonly string[]): Promise<string> {
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(await readFile(join(root, file)))
  }
  return hash.digest("hex")
}

/**
 * Run system `tar` with the given args, resolving the exit code (0 = ok).
 * Uses `spawn` + an exit handler so the awaited promise actually tracks
 * process completion cross-platform (BSD/macOS and GNU tar).
 */
function runTar(args: string[], opts?: { cwd?: string }): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("tar", args, { stdio: "ignore", cwd: opts?.cwd })
    child.once("error", reject)
    child.once("exit", (code) => resolvePromise(code ?? 0))
  })
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

/** Basenames for a path/`{path}`/array-of-either frontmatter field. */
function extractPaths(front: Record<string, unknown>, key: string): string[] | undefined {
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
  const description = typeof front.description === "string" ? front.description : undefined
  const ui = extractPaths(front, "ui")

  return {
    id,
    ...(name !== undefined ? { name } : {}),
    version,
    ...(description !== undefined ? { description } : {}),
    agents: extractIds(front.agents),
    workflows: extractIds(front.workflows),
    ...(ui !== undefined ? { ui } : {}),
  }
}

/**
 * Package `appDir` (must hold `.agentproto/APP.md`) into a `.agentapp`.
 * Without `out`, the file is `<safeId>-<version>.agentapp` in the cwd.
 */
export async function packApp(input: {
  appDir: string
  out?: string
}): Promise<{ file: string; manifest: AgentAppManifest }> {
  const appDirAbs = resolve(input.appDir)

  const appMdPath = join(appDirAbs, ".agentproto", "APP.md")
  if (!(await pathExists(appMdPath))) {
    throw new AgentAppPackError(
      "not-an-app",
      `${appDirAbs} is not an agentproto app (missing ${appMdPath}).`,
    )
  }

  const raw = await readFile(appMdPath, "utf8")
  const front = matter(raw).data as Record<string, unknown>
  const meta = extractMeta(front)

  const outAbs =
    input.out !== undefined
      ? resolve(input.out)
      : resolve(process.cwd(), `${safeId(meta.id)}-${meta.version}.agentapp`)
  await mkdir(dirname(outAbs), { recursive: true })

  const files = (await collectFiles(appDirAbs))
    .filter((f) => f.path !== "manifest.json")
    .filter((f) => join(appDirAbs, f.path) !== outAbs)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const fileCount = files.length
  const totalSize = files.reduce((sum, f) => sum + f.size, 0)

  const sha256 = await aggregateSha256(
    appDirAbs,
    files.map((f) => f.path),
  )

  const manifest: AgentAppManifest = {
    format: AGENTAPP_FORMAT,
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

  // Stage: copy contents into a temp dir, write manifest.json, tar it. The
  // filter also enforces the node_modules/.git exclusion on the actual bundle
  // contents (collectFiles above only shaped the manifest's `files` list) —
  // cp() skips a filtered-out directory's contents entirely.
  const staging = await mkdtemp(join(tmpdir(), "agentapp-"))
  try {
    await cp(appDirAbs, staging, {
      recursive: true,
      filter: (source) => !SKIP_DIR_NAMES.has(basename(source)),
    })
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8")
    // Offline-deterministic archive: pass the entry list explicitly (sorted) so
    // the archive order is reproducible without GNU-only `--sort=name`, which
    // BSD/macOS tar rejects. Dotfiles (`.agentproto`) are included by readdir.
    const entries = (await readdir(staging)).sort()
    const packCode = await runTar(["-czf", outAbs, ...entries], { cwd: staging })
    if (packCode !== 0) {
      throw new AgentAppPackError("tar-failed", `tar failed with exit code ${packCode}`)
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }

  return { file: outAbs, manifest }
}

/** A manifest `files` entry that could read or write outside the bundle root. */
function isUnsafeBundlePath(p: string): boolean {
  if (p === "" || isAbsolute(p)) return true
  return p.split(/[\\/]/).includes("..")
}

/**
 * Extract a `.agentapp`, verify format + aggregate SHA-256, and restore the
 * app folder (without `manifest.json`) into `dest`. Without `dest`, restores
 * into `<safeId>-<version>` in the cwd. A failed verification leaves `dest`
 * untouched (nothing is created).
 */
export async function unpackApp(input: {
  file: string
  dest?: string
}): Promise<{ dir: string; manifest: AgentAppManifest }> {
  const bundleAbs = resolve(input.file)
  if (!(await pathExists(bundleAbs))) {
    throw new AgentAppPackError("bundle-not-found", `bundle not found: ${bundleAbs}`)
  }

  const temp = await mkdtemp(join(tmpdir(), "agentapp-"))
  try {
    const unpackCode = await runTar(["-xzf", bundleAbs, "-C", temp])
    if (unpackCode !== 0) {
      throw new AgentAppPackError("tar-failed", `tar failed with exit code ${unpackCode}`)
    }

    const manifestPath = join(temp, "manifest.json")
    if (!(await pathExists(manifestPath))) {
      throw new AgentAppPackError(
        "missing-manifest",
        `${bundleAbs} is not a valid .agentapp (missing manifest.json).`,
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(manifestPath, "utf8"))
    } catch {
      throw new AgentAppPackError("malformed-manifest", `${bundleAbs} has a malformed manifest.json.`)
    }
    if (!isManifest(parsed)) {
      throw new AgentAppPackError("malformed-manifest", `${bundleAbs} has a malformed manifest.json.`)
    }
    const manifest = parsed

    if (manifest.format !== AGENTAPP_FORMAT) {
      throw new AgentAppPackError(
        "unsupported-format",
        `unsupported bundle format '${manifest.format}' (expected ${AGENTAPP_FORMAT}).`,
      )
    }

    const unsafe = manifest.files.find((f) => typeof f !== "string" || isUnsafeBundlePath(f))
    if (unsafe !== undefined) {
      throw new AgentAppPackError(
        "unsafe-path",
        `manifest.json lists a path outside the bundle root: ${JSON.stringify(unsafe)}.`,
      )
    }

    const actual = await aggregateSha256(temp, manifest.files)
    if (actual !== manifest.sha256) {
      throw new AgentAppPackError(
        "digest-mismatch",
        `SHA-256 mismatch (expected ${manifest.sha256}, got ${actual}). Bundle is corrupted.`,
      )
    }

    const outDir =
      input.dest !== undefined
        ? resolve(input.dest)
        : resolve(process.cwd(), `${safeId(manifest.id)}-${manifest.version}`)
    // Drop the bundle artifact before moving the app contents over.
    await rm(manifestPath, { force: true })
    await mkdir(outDir, { recursive: true })
    await cp(temp, outDir, { recursive: true })

    return { dir: outDir, manifest }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
