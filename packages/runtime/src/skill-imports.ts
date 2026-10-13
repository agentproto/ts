/**
 * `~/.agentproto/imported-skills.json` — the user's curated set of skill
 * folders the daemon should deliver to spawned sessions.
 *
 * Mirrors `mcp-imports.ts` for MCP servers. Where `mcp_import` snapshots a
 * discovered server, a skill import COPIES a skill folder (the dir holding
 * `SKILL.md`) into `~/.agentproto/skills/<id>/` and records a content hash.
 * Copying, not symlinking, keeps the delivered tree stable if the source is
 * moved/deleted — and lets `resyncImportedSkill` re-copy on demand.
 *
 * File shape:
 *   {
 *     "version": 1,
 *     "imports": [
 *       {
 *         "id":         "ap-import-mcp",   // the skill's frontmatter `name`
 *         "alias":      "ap-import-mcp",    // display/dir name (default = id)
 *         "sourcePath": "/path/to/skill",  // the folder the user pointed at
 *         "sha":        "…",               // sha256 over the copied tree
 *         "addedAt":    "2026-10-13T…"
 *       }
 *     ]
 *   }
 *
 * `sha` is a sha256 over the sorted relative paths + bytes of the copied
 * tree — `resyncImportedSkill` compares it against a freshly hashed source
 * to decide whether a re-copy is needed.
 */

import { createHash, randomBytes } from "node:crypto"
import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path"
import matter from "gray-matter"
import { z } from "zod"

export const IMPORTED_SKILLS_PATH = (): string =>
  resolvePath(homedir(), ".agentproto", "imported-skills.json")

/** Root holding one copied folder per import (`<root>/<id>/SKILL.md`). */
export const IMPORTED_SKILLS_ROOT = (): string =>
  resolvePath(homedir(), ".agentproto", "skills")

export const IMPORTED_SKILLS_VERSION = 1 as const

/** Every AIP-3 skill folder is identified by this file at its root. */
export const SKILL_FILE = "SKILL.md"

/**
 * The subset of AIP-3 frontmatter the registry relies on. `@agentproto/skill`
 * owns the full schema; runtime doesn't depend on that package, so this mirrors
 * the fields that gate an import (name is the identity, description is
 * required by AIP-3). Unknown frontmatter keys are tolerated (`.loose()`).
 */
export const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/

/**
 * An `alias` names the directory the driver copies a skill into
 * (`<session config dir>/skills/<alias>/`), so it MUST be a bare slug — no
 * path separators, no `..`, no leading dot. Reusing `NAME_PATTERN` (the AIP-3
 * skill-name grammar) guarantees it can never escape the target dir.
 */
export function assertValidAlias(alias: string): void {
  if (!NAME_PATTERN.test(alias)) {
    throw new Error(
      `alias "${alias}" is invalid — must match ${NAME_PATTERN.source} ` +
        "(lowercase letters/digits, single hyphens, no leading/trailing hyphen).",
    )
  }
}
const skillFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(64).regex(NAME_PATTERN),
    description: z.string().min(1).max(1024),
  })
  .loose()

export interface ImportedSkillEntry {
  /** Stable identity: the skill's frontmatter `name`. */
  id: string
  /** Display/dir name — defaults to `id`, overridable at import time. */
  alias: string
  /** The folder the user pointed at (kept so `resync` can re-read it). */
  sourcePath: string
  /** sha256 over the copied tree (sorted relative paths + bytes). */
  sha: string
  addedAt: string
}

export interface ImportedSkillsConfig {
  version: typeof IMPORTED_SKILLS_VERSION
  imports: ImportedSkillEntry[]
}

const EMPTY: ImportedSkillsConfig = {
  version: IMPORTED_SKILLS_VERSION,
  imports: [],
}

/** Where a given import's copied tree lives. */
export function skillImportDir(id: string, root: string = IMPORTED_SKILLS_ROOT()): string {
  return join(root, id)
}

/** Injectable paths so tests never touch the real `~/.agentproto`. */
export interface SkillImportPaths {
  registryPath?: string
  root?: string
}

export async function loadImportedSkills(
  path: string = IMPORTED_SKILLS_PATH()
): Promise<ImportedSkillsConfig> {
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

export async function saveImportedSkills(
  config: ImportedSkillsConfig,
  path: string = IMPORTED_SKILLS_PATH()
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  // Unique per writer: two concurrent saves in one daemon must not share a
  // temp path (they'd clobber each other's rename source).
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  })
  await fs.rename(tmp, path)
}

/**
 * In-process mutex serializing a registry load-modify-save. `saveImportedSkills`
 * writes the WHOLE file, so two concurrent callers (import/remove/resync, or a
 * resync racing an import) that both load, mutate, then save would lose one
 * another's changes — last writer wins. Chaining on a shared promise makes the
 * read-modify-write atomic within this process. (Cross-process safety still
 * rests on the atomic rename in `saveImportedSkills`.)
 */
let registryLock: Promise<void> = Promise.resolve()
async function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = registryLock
  let release!: () => void
  registryLock = new Promise<void>(resolve => {
    release = resolve
  })
  await prev
  try {
    return await fn()
  } finally {
    release()
  }
}

/** The current imports (convenience over `loadImportedSkills`). */
export async function listImportedSkills(
  paths: SkillImportPaths = {}
): Promise<ImportedSkillEntry[]> {
  const config = await loadImportedSkills(paths.registryPath ?? IMPORTED_SKILLS_PATH())
  return config.imports
}

/** Find an import by its `id` OR its `alias` — the spawn-resolution lookup. */
export function resolveImportedSkill(
  config: ImportedSkillsConfig,
  idOrAlias: string
): ImportedSkillEntry | undefined {
  return config.imports.find(e => e.id === idOrAlias || e.alias === idOrAlias)
}

/** A skill resolved for per-session delivery: the alias names the dir the
 *  driver copies into, `path` is the durable imported copy (NOT `sourcePath`). */
export interface ResolvedSessionSkill {
  alias: string
  path: string
}

export interface ResolveSessionSkillsResult {
  resolved: ResolvedSessionSkill[]
  warnings: string[]
}

/**
 * Map a spawn's resolved skill ids onto the imported registry. Each id matches
 * by `id` OR `alias`. An id that isn't imported is NOT an error — it stays in
 * the adapter-facing `skills` list (hermes resolves it; others may
 * auto-discover) — but it IS reported as a warning so the operator can see why
 * nothing was delivered for it (same shape/style as `mountImports` warnings).
 * Duplicate matches (id and alias both listed) collapse to one delivery.
 *
 * `path` points at the copied tree under the registry root, not the entry's
 * `sourcePath`: delivery must survive the source folder moving or being
 * deleted (that's the whole point of importing a snapshot).
 */
export function resolveSessionSkills(
  ids: readonly string[],
  config: ImportedSkillsConfig,
  root: string = IMPORTED_SKILLS_ROOT()
): ResolveSessionSkillsResult {
  const resolved: ResolvedSessionSkill[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const entry = resolveImportedSkill(config, id)
    if (!entry) {
      warnings.push(
        `agent_start: skill "${id}" is not in the imported-skills registry — not ` +
          "delivered to this session. Import it with the skill_import tool to have " +
          "it delivered.",
      )
      continue
    }
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    resolved.push({ alias: entry.alias, path: skillImportDir(entry.id, root) })
  }
  return { resolved, warnings }
}

/**
 * Parse a `SKILL.md`'s frontmatter, enforcing the AIP-3 minimum (a valid
 * `name` + a `description`). Throws with a field-naming message.
 */
export function parseSkillFrontmatter(raw: string): { name: string; description: string } {
  let data: unknown
  try {
    data = matter(raw).data
  } catch (err) {
    throw new Error(
      `${SKILL_FILE} frontmatter is not valid YAML (${
        err instanceof Error ? err.message : String(err)
      })`
    )
  }
  const parsed = skillFrontmatterSchema.safeParse(data)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const field = issue?.path.join(".") || "frontmatter"
    throw new Error(`${SKILL_FILE} frontmatter is invalid: ${field} — ${issue?.message ?? "invalid"}`)
  }
  return { name: parsed.data.name, description: parsed.data.description }
}

/**
 * Recursively list files under `dir`, as POSIX-style relative paths. Symlinks
 * are FOLLOWED (matching `copySkillDir`'s dereference) so the hash reflects the
 * bytes actually delivered; visited realpaths are tracked so a link cycle can't
 * loop forever. A symlink whose target resolves OUTSIDE `dir` is REFUSED: with
 * dereference the copy would otherwise pull its target's content (e.g. a link
 * to `~/.ssh`) into the registry — and from there into every session's config
 * dir, bypassing fs-zone confinement — while a link to `/` or `$HOME` would
 * make this walk traverse the whole tree (DoS).
 */
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const visited = new Set<string>()
  let rootReal: string
  try {
    rootReal = await fs.realpath(dir)
  } catch {
    return out
  }
  const walk = async (abs: string): Promise<void> => {
    let real: string
    try {
      real = await fs.realpath(abs)
    } catch {
      return
    }
    if (visited.has(real)) return
    visited.add(real)
    const entries = await fs.readdir(abs, { withFileTypes: true })
    for (const entry of entries) {
      const child = join(abs, entry.name)
      const rel = relative(dir, child).split(sep).join("/")
      let isLink = entry.isSymbolicLink()
      if (!isLink) {
        // Dirent type can be "unknown" on some filesystems; fall back to lstat.
        try {
          isLink = (await fs.lstat(child)).isSymbolicLink()
        } catch {
          continue
        }
      }
      if (isLink) {
        let target: string
        try {
          target = await fs.realpath(child)
        } catch {
          continue
        }
        if (!pathContains(rootReal, target)) {
          throw new Error(
            `skill source contains a symlink that escapes the skill folder: ` +
              `"${rel}" -> "${target}" — copy the real content in instead.`
          )
        }
      }
      let stat
      try {
        stat = await fs.stat(child)
      } catch {
        continue
      }
      if (stat.isDirectory()) await walk(child)
      else if (stat.isFile()) out.push(rel)
    }
  }
  await walk(dir)
  return out
}

/**
 * sha256 over the sorted relative paths + bytes of a skill tree. A rename or
 * any byte change moves the hash; directory mtimes do not. Symlinks are
 * dereferenced (matching the copy), so the hash is over the delivered bytes.
 */
export async function computeSkillDirSha(dir: string): Promise<string> {
  const files = (await listFiles(dir)).sort()
  const hash = createHash("sha256")
  for (const rel of files) {
    const bytes = await fs.readFile(join(dir, rel))
    hash.update(`${rel}\n`)
    hash.update(`${bytes.byteLength}\n`)
    hash.update(bytes)
  }
  return hash.digest("hex")
}

async function copySkillDir(source: string, dest: string): Promise<void> {
  // Copy into a unique temp dir, then rename into place: a concurrent resync/
  // import of the same id can't observe a half-written tree, and a failure
  // mid-copy leaves the previous good copy untouched.
  await fs.mkdir(dirname(dest), { recursive: true })
  let sourceReal: string
  try {
    sourceReal = await fs.realpath(source)
  } catch {
    sourceReal = resolvePath(source)
  }
  const tmp = `${dest}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`
  await fs.rm(tmp, { recursive: true, force: true })
  try {
    // `dereference: true` so a symlink anywhere in the tree — the top-level
    // source itself, or a nested `scripts/` link — is copied as real content.
    // The registry is a snapshot and must not depend on paths outside it. The
    // `filter` is defence-in-depth on top of `listFiles`' pre-copy walk: it
    // SKIPS any link whose realpath leaves the source, so the copy can never
    // follow an escaping link even if validation were bypassed.
    await fs.cp(source, tmp, {
      recursive: true,
      dereference: true,
      filter: async src => {
        let st
        try {
          st = await fs.lstat(src)
        } catch {
          return true
        }
        if (!st.isSymbolicLink()) return true
        let real: string
        try {
          real = await fs.realpath(src)
        } catch {
          return false
        }
        return pathContains(sourceReal, real)
      },
    })
    await fs.rm(dest, { recursive: true, force: true })
    await fs.rename(tmp, dest)
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

async function assertSkillSource(sourcePath: string): Promise<string> {
  const abs = resolvePath(sourcePath)
  let stat
  try {
    stat = await fs.stat(abs)
  } catch {
    throw new Error(`skill source "${sourcePath}" does not exist`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`skill source "${sourcePath}" is not a directory`)
  }
  // Resolve symlinks so the COPY is a real snapshot: `fs.cp` would otherwise
  // reproduce a symlinked source as a symlink into the registry, and the
  // "durable snapshot" guarantee would be a lie.
  let real: string
  try {
    real = await fs.realpath(abs)
  } catch {
    throw new Error(`skill source "${sourcePath}" could not be resolved`)
  }
  const skillFile = join(real, SKILL_FILE)
  try {
    await fs.access(skillFile)
  } catch {
    throw new Error(`skill source "${sourcePath}" has no ${SKILL_FILE}`)
  }
  return real
}

export interface ImportSkillResult {
  config: ImportedSkillsConfig
  entry: ImportedSkillEntry
}

export interface ImportSkillInput {
  sourcePath: string
  alias?: string
}

/** True when `child` is `parent` itself or sits inside it. */
function pathContains(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** The registry root's realpath, or undefined when it doesn't exist yet (no
 *  overlap is possible against a path that isn't there). */
async function realRegistryRoot(root: string): Promise<string | undefined> {
  try {
    return await fs.realpath(root)
  } catch {
    return undefined
  }
}

/**
 * Reject a source that overlaps the registry root in EITHER direction. A
 * source INSIDE the root (e.g. an existing import's own copy, or the root
 * itself) would be wiped by the `rm(dest)` before the copy; a source that
 * CONTAINS the root would have the whole imports tree deleted by the same rm.
 * Returns the refusal message, or undefined when there's no overlap.
 */
function registryOverlapMessage(
  sourceReal: string,
  realRoot: string | undefined,
): string | undefined {
  if (!realRoot) return undefined
  if (pathContains(realRoot, sourceReal) || pathContains(sourceReal, realRoot)) {
    return (
      `skill source "${sourceReal}" overlaps the imports root "${realRoot}" — ` +
      "importing it would delete the source tree. Point at the ORIGINAL skill " +
      "folder, not a copy under the registry root."
    )
  }
  return undefined
}

/**
 * Copy a skill folder into the registry and record it. Throws when the source
 * lacks a valid `SKILL.md` (the caller — `skill_import` — turns that into an
 * error reply). An existing import with the same id is replaced in place.
 */
export async function importSkill(
  input: ImportSkillInput,
  paths: SkillImportPaths = {}
): Promise<ImportSkillResult> {
  return withRegistryLock(async () => {
    const root = paths.root ?? IMPORTED_SKILLS_ROOT()
    const registryPath = paths.registryPath ?? IMPORTED_SKILLS_PATH()
    const sourcePath = await assertSkillSource(input.sourcePath)
    const overlap = registryOverlapMessage(sourcePath, await realRegistryRoot(root))
    if (overlap) throw new Error(overlap)
    // Refuse an escaping symlink BEFORE the copy: with `dereference` the copy
    // would otherwise pull the link target's content into the registry (and
    // on into every session's config dir), and a link to `/` or `$HOME` would
    // make the walk traverse the whole tree. In-tree links pass.
    await listFiles(sourcePath)
    const raw = await fs.readFile(join(sourcePath, SKILL_FILE), "utf8")
    const { name } = parseSkillFrontmatter(raw)
    const alias = (input.alias ?? name).trim()
    assertValidAlias(alias)

    const config = await loadImportedSkills(registryPath)
    // Resolution matches by id OR alias, so ANY collision — the new alias
    // against an existing id OR alias, and the new id against an existing
    // alias — would make resolution ambiguous (and two imports could target
    // the same delivery dir). Check both directions. `e.id !== name` excludes
    // this id's own prior entry (a re-import replaces it in place).
    const clash = config.imports.find(
      e => e.id !== name && (e.id === alias || e.alias === alias || e.alias === name),
    )
    if (clash) {
      throw new Error(
        `id "${name}" or alias "${alias}" is already used by import "${clash.id}" ` +
          `(alias "${clash.alias}") — pick a different alias.`,
      )
    }

    const dest = skillImportDir(name, root)
    await copySkillDir(sourcePath, dest)
    const sha = await computeSkillDirSha(dest)
    const entry: ImportedSkillEntry = {
      id: name,
      alias,
      sourcePath,
      sha,
      addedAt: new Date().toISOString(),
    }
    const next: ImportedSkillsConfig = {
      ...config,
      imports: [...config.imports.filter(e => e.id !== entry.id), entry],
    }
    await saveImportedSkills(next, registryPath)
    return { config: next, entry }
  })
}

export interface RemoveSkillResult {
  config: ImportedSkillsConfig
  removed: boolean
}

/** Drop an import and delete its copied tree (best-effort). */
export async function removeImportedSkill(
  id: string,
  paths: SkillImportPaths = {}
): Promise<RemoveSkillResult> {
  return withRegistryLock(async () => {
    const root = paths.root ?? IMPORTED_SKILLS_ROOT()
    const registryPath = paths.registryPath ?? IMPORTED_SKILLS_PATH()
    const config = await loadImportedSkills(registryPath)
    if (!config.imports.some(e => e.id === id)) {
      return { config, removed: false }
    }
    const next: ImportedSkillsConfig = {
      ...config,
      imports: config.imports.filter(e => e.id !== id),
    }
    await saveImportedSkills(next, registryPath)
    await fs.rm(skillImportDir(id, root), { recursive: true, force: true }).catch(() => {})
    return { config: next, removed: true }
  })
}

export interface ResyncSkillResult {
  config: ImportedSkillsConfig
  entry?: ImportedSkillEntry
  /** True when the source hash differed and a re-copy happened. */
  changed: boolean
  warnings: string[]
}

/**
 * Re-copy an import from its `sourcePath` when the source's content hash
 * differs from the recorded `sha` (or when the copied tree went missing).
 * A missing/unreadable source is a warning, never a throw — it leaves the
 * existing entry intact.
 */
export async function resyncImportedSkill(
  id: string,
  paths: SkillImportPaths = {}
): Promise<ResyncSkillResult> {
  return withRegistryLock(async () => {
    const root = paths.root ?? IMPORTED_SKILLS_ROOT()
    const registryPath = paths.registryPath ?? IMPORTED_SKILLS_PATH()
    const config = await loadImportedSkills(registryPath)
    const entry = config.imports.find(e => e.id === id)
    if (!entry) return { config, changed: false, warnings: [`import "${id}" not found`] }

    let sourceReal: string
    let sourceSha: string
    try {
      sourceReal = await assertSkillSource(entry.sourcePath)
      sourceSha = await computeSkillDirSha(sourceReal)
    } catch (err) {
      return {
        config,
        entry,
        changed: false,
        warnings: [
          `could not resync "${id}" from ${entry.sourcePath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ],
      }
    }

    const dest = skillImportDir(entry.id, root)
    let destSha: string | undefined
    try {
      destSha = await computeSkillDirSha(dest)
    } catch {
      destSha = undefined
    }
    if (destSha === sourceSha) {
      return { config, entry, changed: false, warnings: [] }
    }

    // A legacy/hand-edited entry could carry a `sourcePath` that — after
    // resolving symlinks — overlaps the root; re-copying it would delete the
    // source. Warn and leave it intact.
    const overlap = registryOverlapMessage(sourceReal, await realRegistryRoot(root))
    if (overlap) return { config, entry, changed: false, warnings: [overlap] }

    await copySkillDir(sourceReal, dest)
    const updated: ImportedSkillEntry = { ...entry, sha: await computeSkillDirSha(dest) }
    const next: ImportedSkillsConfig = {
      ...config,
      imports: config.imports.map(e => (e.id === id ? updated : e)),
    }
    await saveImportedSkills(next, registryPath)
    return { config: next, entry: updated, changed: true, warnings: [] }
  })
}

function normalize(parsed: unknown): ImportedSkillsConfig {
  if (!parsed || typeof parsed !== "object") return EMPTY
  const obj = parsed as Record<string, unknown>
  const imports: ImportedSkillEntry[] = []
  if (Array.isArray(obj.imports)) {
    for (const entry of obj.imports) {
      if (!entry || typeof entry !== "object") continue
      const e = entry as Record<string, unknown>
      const id = typeof e.id === "string" ? e.id : ""
      if (!id) continue
      const alias = typeof e.alias === "string" && e.alias ? e.alias : id
      const sourcePath = typeof e.sourcePath === "string" ? e.sourcePath : ""
      const sha = typeof e.sha === "string" ? e.sha : ""
      const addedAt =
        typeof e.addedAt === "string" ? e.addedAt : new Date().toISOString()
      imports.push({ id, alias, sourcePath, sha, addedAt })
    }
  }
  return { version: IMPORTED_SKILLS_VERSION, imports }
}
