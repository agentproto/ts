/**
 * `.agentapp` pack / unpack core (AIP-53 §"The `.agentapp` package format").
 *
 * PACK   walks the app dir (skipping `node_modules/` and `.git/` at any
 *        depth), applies the APP.md `package` include/exclude rules (plus
 *        RELEASE_DEFAULT_EXCLUDE in release mode), stages ONLY the selected
 *        files (rewriting APP.md without `ui.build` when stripping), writes a
 *        `manifest.json` at the bundle root, and tars the staged CONTENTS
 *        with system `tar`, so extraction yields `manifest.json` +
 *        `.agentproto/` + loose files at the top level.
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

import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path"
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
  | "invalid-package"
  | "missing-ui"

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
 * Release-mode default excludes: dev-only trees and artifacts that must never
 * ship in a published `.agentapp` (UI sources, docs, runtime data, scripts,
 * dev harnesses, tests, repo docs and tooling config, logs, source maps, env
 * files). Nothing the runtime reads: an installed app is its
 * `.agentproto/` tree plus the files its workflows import. APP.md
 * `package.exclude` ADDS to this list in release mode; it never removes
 * from it. `LICENSE` / `NOTICE` are deliberately NOT excluded.
 */
export const RELEASE_DEFAULT_EXCLUDE: readonly string[] = [
  "ui/**",
  "docs/**",
  "data/**",
  "scripts/**",
  // Root-level only: `**/dev/**` would also drop a shipped agent named
  // `dev` (`.agentproto/agents/dev/`); `ui/dev/` is covered by `ui/**`.
  // Same for `test/` and `tests/`.
  "dev/**",
  "test/**",
  "tests/**",
  // Test files and folders anywhere (a workflow's `foo.test.mjs` next to
  // its `entry.mjs`); these names are never a runtime import.
  "**/__tests__/**",
  "**/*.test.*",
  "**/*.spec.*",
  // Repo docs at the app root (the catalog entry carries the description).
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  // Repo and editor tooling.
  ".github/**",
  ".vscode/**",
  ".idea/**",
  ".gitignore",
  ".editorconfig",
  "tsconfig*.json",
  "vitest.config.*",
  "jest.config.*",
  "eslint.config.*",
  ".eslintrc*",
  ".prettierrc*",
  "**/*.log",
  "**/*.map",
  "**/.DS_Store",
  "**/.env",
  "**/.env.*",
]

/** APP.md `package` block — what a `.agentapp` ships. All fields optional. */
export interface AppPackageRules {
  /** When set, only files matching one of these globs ship (APP.md and the
   *  `ui.path` entry + its `assets/` are always kept). */
  include?: string[]
  /** Files matching any of these globs are dropped. */
  exclude?: string[]
  /** Remove `ui.build` from the packed APP.md. Default: true in release mode,
   *  false otherwise. */
  stripBuild?: boolean
}

/**
 * Glob → RegExp over a `/`-separated relative path. `**` spans any number of
 * segments (including none when followed by `/`), `*` stays inside one
 * segment. No braces, no negation, no `?` — enough for package rules without
 * a glob dependency.
 */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/^\.\//, "")
  let re = ""
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++
        if (g[i + 1] === "/") {
          i++
          re += "(?:.*/)?"
        } else {
          re += ".*"
        }
      } else {
        re += "[^/]*"
      }
    } else if ("\\^$+?.()|{}[]".includes(c)) {
      re += "\\" + c
    } else {
      re += c
    }
  }
  return new RegExp(`^${re}$`)
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/")
}

function matchesAny(path: string, globs: readonly RegExp[]): boolean {
  const p = toPosix(path)
  return globs.some((re) => re.test(p))
}

/** Read + validate the APP.md `package` block. Throws `invalid-package`. */
export function readPackageRules(front: Record<string, unknown>): AppPackageRules {
  const raw = front.package
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentAppPackError("invalid-package", "APP.md `package` must be an object.")
  }
  const r = raw as Record<string, unknown>
  const list = (key: "include" | "exclude"): string[] | undefined => {
    const v = r[key]
    if (v === undefined) return undefined
    if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || s.trim() === "")) {
      throw new AgentAppPackError(
        "invalid-package",
        `APP.md \`package.${key}\` must be an array of non-empty glob strings.`,
      )
    }
    return v as string[]
  }
  if (r.stripBuild !== undefined && typeof r.stripBuild !== "boolean") {
    throw new AgentAppPackError("invalid-package", "APP.md `package.stripBuild` must be a boolean.")
  }
  const include = list("include")
  const exclude = list("exclude")
  return {
    ...(include !== undefined ? { include } : {}),
    ...(exclude !== undefined ? { exclude } : {}),
    ...(typeof r.stripBuild === "boolean" ? { stripBuild: r.stripBuild } : {}),
  }
}

/** APP.md `ui.path` (string or `{path}`) as a posix path relative to the app
 *  dir, or undefined when absent / absolute / escaping the app dir. */
function uiRelPath(front: Record<string, unknown>): string | undefined {
  const ui = front.ui
  const raw =
    typeof ui === "string"
      ? ui
      : ui && typeof ui === "object" && !Array.isArray(ui) && typeof (ui as { path?: unknown }).path === "string"
        ? (ui as { path: string }).path
        : undefined
  if (raw === undefined || raw === "" || isAbsolute(raw)) return undefined
  const rel = posix.normalize(toPosix(raw)).replace(/^\.\//, "")
  if (rel.startsWith("../") || rel === "..") return undefined
  return rel
}

/**
 * Package `appDir` (must hold `.agentproto/APP.md`) into a `.agentapp`.
 * Without `out`, the file is `<safeId>-<version>.agentapp` in the cwd.
 *
 * File selection: every file under `appDir` minus `node_modules/`/`.git/`,
 * then the APP.md `package` rules (`include` restricts, `exclude` drops). In
 * `release` mode {@link RELEASE_DEFAULT_EXCLUDE} is added to `exclude`, the
 * built `ui.path` must be in the bundle (`missing-ui` otherwise), and
 * `ui.build` is stripped from the packed APP.md (override with
 * `package.stripBuild`). `.agentproto/APP.md`, the `ui.path` entry and the
 * files under its sibling `assets/` dir always ship. Only the selected files
 * are staged, and the SHA covers the staged bytes (so a rewritten APP.md is
 * what gets hashed).
 */
export async function packApp(input: {
  appDir: string
  out?: string
  release?: boolean
}): Promise<{ file: string; manifest: AgentAppManifest }> {
  const appDirAbs = resolve(input.appDir)
  const release = input.release === true

  const appMdPath = join(appDirAbs, ".agentproto", "APP.md")
  if (!(await pathExists(appMdPath))) {
    throw new AgentAppPackError(
      "not-an-app",
      `${appDirAbs} is not an agentproto app (missing ${appMdPath}).`,
    )
  }

  const raw = await readFile(appMdPath, "utf8")
  const parsedAppMd = matter(raw)
  const front = parsedAppMd.data as Record<string, unknown>
  const meta = extractMeta(front)
  const rules = readPackageRules(front)

  const outAbs =
    input.out !== undefined
      ? resolve(input.out)
      : resolve(process.cwd(), `${safeId(meta.id)}-${meta.version}.agentapp`)
  await mkdir(dirname(outAbs), { recursive: true })

  const appMdRel = ".agentproto/APP.md"
  const uiRel = uiRelPath(front)
  const uiAssetsPrefix = uiRel !== undefined ? `${posix.dirname(uiRel)}/assets/`.replace(/^\.\//, "") : undefined
  const includeRes = rules.include?.map(globToRegExp)
  const excludeRes = [...(release ? RELEASE_DEFAULT_EXCLUDE : []), ...(rules.exclude ?? [])].map(globToRegExp)
  const alwaysShip = (p: string): boolean =>
    p === appMdRel || p === uiRel || (uiAssetsPrefix !== undefined && p.startsWith(uiAssetsPrefix))

  const selected = (await collectFiles(appDirAbs))
    .filter((f) => f.path !== "manifest.json")
    .filter((f) => join(appDirAbs, f.path) !== outAbs)
    .filter((f) => {
      const p = toPosix(f.path)
      if (alwaysShip(p)) return true
      if (includeRes !== undefined && !matchesAny(p, includeRes)) return false
      return !matchesAny(p, excludeRes)
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  if (release && uiRel !== undefined && !selected.some((f) => toPosix(f.path) === uiRel)) {
    throw new AgentAppPackError(
      "missing-ui",
      `ui.path "${uiRel}" does not exist in ${appDirAbs} — build the UI first ` +
        "(`agentproto app build <appDir>`, or `agentproto app pack --release`, which runs `ui.build`).",
    )
  }

  const stripBuild = rules.stripBuild ?? release

  // Stage ONLY the selected files, optionally rewrite APP.md, then hash and
  // tar what is actually staged — excluded files never reach the archive.
  const staging = await mkdtemp(join(tmpdir(), "agentapp-"))
  try {
    for (const f of selected) {
      const dest = join(staging, f.path)
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(join(appDirAbs, f.path), dest)
    }

    if (stripBuild) {
      const ui = front.ui
      if (ui && typeof ui === "object" && !Array.isArray(ui) && "build" in ui) {
        // Clone: gray-matter caches parse results per input string, so the
        // cached `data` object must not be mutated.
        const data = structuredClone(front)
        delete (data.ui as Record<string, unknown>).build
        await writeFile(join(staging, appMdRel), matter.stringify(parsedAppMd.content, data), "utf8")
      }
    }

    const files: BundleFile[] = []
    for (const f of selected) {
      files.push({ path: f.path, size: (await stat(join(staging, f.path))).size })
    }
    const fileCount = files.length
    const totalSize = files.reduce((sum, f) => sum + f.size, 0)
    const sha256 = await aggregateSha256(
      staging,
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

    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8")
    // Offline-deterministic archive: pass the entry list explicitly (sorted) so
    // the archive order is reproducible without GNU-only `--sort=name`, which
    // BSD/macOS tar rejects. Dotfiles (`.agentproto`) are included by readdir.
    const entries = (await readdir(staging)).sort()
    const packCode = await runTar(["-czf", outAbs, ...entries], { cwd: staging })
    if (packCode !== 0) {
      throw new AgentAppPackError("tar-failed", `tar failed with exit code ${packCode}`)
    }
    return { file: outAbs, manifest }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
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
