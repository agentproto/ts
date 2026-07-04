/**
 * agentproto install skill/SLUG — install AIP-3 skills from the
 * bundled agentproto plugin pack into target agents (hermes, claude-code).
 *
 * Resolves the pack directory by globbing .skills/agentproto-plugin-v*
 * from the repo root, picking the highest semver. Each skill lives at
 * pack/skills/NAME/ with a SKILL.md + optional assets.
 *
 * Phase 1–2 targets: hermes (copy to ~/.hermes/skills/), claude-code
 * (emit the plugin bundle). Claude Desktop is a follow-up.
 */

import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { dirname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { parseArgs } from "node:util"
import { homedir } from "node:os"
import matter from "gray-matter"

// ── types ──────────────────────────────────────────────────────────────

type SkillTarget = "hermes" | "claude-code" | "claude-desktop"

interface SkillInfo {
  name: string
  description: string
  dir: string
}

interface InstallOpts {
  target: SkillTarget
  slug: string
  force: boolean
  dryRun: boolean
  outDir: string
}

interface InstallAction {
  target: SkillTarget
  status: "created" | "overwritten" | "skipped" | "dry-run"
  label: string
  detail: string
}

// ── public entry ───────────────────────────────────────────────────────

export async function runInstallSkill(
  slug: string,
  args: readonly string[],
): Promise<number> {
  const rawSlug = slug.startsWith("skill/") ? slug.slice("skill/".length) : slug

  if (!rawSlug.length) {
    process.stderr.write(
      "agentproto install skill: missing skill slug. Try: agentproto install skill/agent-session-orchestration-agentproto\n",
    )
    return 2
  }

  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      target: { type: "string", multiple: true },
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
      list: { type: "boolean" },
      out: { type: "string" },
    },
  })

  // --list → dump skill names + descriptions and exit
  if (values.list) {
    const packDir = await resolveSkillPackDir()
    if (!packDir) {
      process.stderr.write(
        "agentproto install skill: could not resolve the agentproto skill pack directory.\n",
      )
      return 1
    }
    const skills = await listSkills(packDir)
    if (skills.length === 0) {
      process.stdout.write("(no skills found in pack)\n")
      return 0
    }
    for (const s of skills) {
      process.stdout.write(`${s.name.padEnd(44)} ${s.description}\n`)
    }
    return 0
  }

  // Validate slug — must be a real skill name or "agentproto-pack"
  if (
    rawSlug !== "agentproto-pack" &&
    !/^[a-z][a-z0-9-]*$/.test(rawSlug)
  ) {
    process.stderr.write(
      `agentproto install skill: invalid skill slug '${rawSlug}'. Lower-kebab only.\n`,
    )
    return 2
  }

  // Determine targets: explicit --target flags or auto-detect
  const explicitTargets: string[] = values.target ?? []
  const targets = resolveTargets(explicitTargets)
  if (targets.length === 0) {
    process.stderr.write(
      "agentproto install skill: no targets specified and none auto-detected. Pass --target hermes or --target claude-code.\n",
    )
    return 2
  }

  // Resolve the pack
  const packDir = await resolveSkillPackDir()
  if (!packDir) {
    process.stderr.write(
      "agentproto install skill: could not resolve the agentproto skill pack directory.\n",
    )
    return 1
  }

  // Resolve skills
  let skills: SkillInfo[]
  if (rawSlug === "agentproto-pack") {
    skills = await listSkills(packDir)
    if (skills.length === 0) {
      process.stdout.write("No skills found in the agentproto pack.\n")
      return 0
    }
  } else {
    const skillDir = join(packDir, "skills", rawSlug)
    if (!(await pathExists(join(skillDir, "SKILL.md")))) {
      process.stderr.write(
        `agentproto install skill: skill '${rawSlug}' not found in the pack. ` +
          "Run `agentproto install skill/agentproto-pack --list` to see available skills.\n",
      )
      return 1
    }
    const fm = await parseSkillFrontmatter(skillDir)
    skills = [fm]
  }

  const outDir = values.out
    ? normalize(values.out)
    : join(process.cwd(), "agentproto-skill-plugin")

  const actions: InstallAction[] = []

  for (const target of targets) {
    const opts: InstallOpts = {
      target,
      slug: rawSlug,
      force: values.force === true,
      dryRun: values["dry-run"] === true,
      outDir,
    }

    for (const skill of skills) {
      const result = await installOne(skill, opts)
      actions.push(result)
    }
  }

  // Summary
  if (actions.length === 0) {
    process.stdout.write("Nothing to install.\n")
    return 0
  }

  for (const a of actions) {
    const prefix = a.status === "dry-run" ? "[dry-run] " : ""
    process.stdout.write(
      `  ${prefix}${a.target}: ${a.label} — ${a.status}\n`,
    )
  }

  const failed = actions.filter(
    (a) => a.status !== "created" && a.status !== "overwritten" && a.status !== "dry-run" && a.status !== "skipped",
  )
  if (failed.length > 0) {
    process.stderr.write(
      `${failed.length} install(s) skipped or failed. See details above.\n`,
    )
  }

  return failed.length === 0 ? 0 : 1
}

// ── pack resolution ────────────────────────────────────────────────────

/** Find the repo root by walking up from this source file. */
async function findRepoRoot(): Promise<string | null> {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, ".skills")
    try {
      const s = await stat(candidate)
      if (s.isDirectory()) return dir
    } catch {
      // not found here
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Glob .skills/agentproto-plugin-v* from the repo root, pick the
 * highest semver. Returns the absolute path to the pack dir.
 *
 * TODO: bundle the pack into the CLI package for a published build
 * so we do not rely on a repo layout.
 */
async function resolveSkillPackDir(): Promise<string | null> {
  const root = await findRepoRoot()
  if (!root) return null

  const skillsDir = join(root, ".skills")
  let entries: string[]
  try {
    entries = await readdir(skillsDir)
  } catch {
    return null
  }

  const prefix = "agentproto-plugin-v"
  const candidates: { name: string; version: string; path: string }[] = []

  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    const version = entry.slice(prefix.length)
    // Basic semver-like check: digits.digits.digits(-prerelease)?
    if (!/^\d+\.\d+\.\d+/.test(version)) continue
    const fullPath = join(skillsDir, entry)
    try {
      const s = await stat(fullPath)
      if (s.isDirectory()) {
        candidates.push({ name: entry, version, path: fullPath })
      }
    } catch {
      // skip
    }
  }

  if (candidates.length === 0) return null

  // Sort by semver descending, pick highest
  candidates.sort((a, b) => compareSemver(b.version, a.version))
  const selected = candidates[0]
  if (!selected) return null
  return selected.path
}

/** Simple semver comparator for major.minor.patch(-prerelease) strings. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/)
    if (!m) return null
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return 0
  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  return pa.patch - pb.patch
}

// ── skill listing / parsing ────────────────────────────────────────────

async function listSkills(packDir: string): Promise<SkillInfo[]> {
  const skillsDir = join(packDir, "skills")
  let entries: string[]
  try {
    entries = await readdir(skillsDir)
  } catch {
    return []
  }

  const results: SkillInfo[] = []
  for (const entry of entries) {
    const skillDir = join(skillsDir, entry)
    try {
      const st = await stat(skillDir)
      if (!st.isDirectory()) continue
    } catch {
      continue
    }
    try {
      const fm = await parseSkillFrontmatter(skillDir)
      results.push(fm)
    } catch {
      // Skip skills whose SKILL.md can't be parsed
    }
  }
  // Sort by name for stable output
  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}

/**
 * Parse the YAML frontmatter from a skill's SKILL.md.
 * Returns the skill name and description.
 */
export async function parseSkillFrontmatter(skillDir: string): Promise<SkillInfo> {
  const mdPath = join(skillDir, "SKILL.md")
  const raw = await readFile(mdPath, "utf8")
  const parsed = matter(raw)

  if (Object.keys(parsed.data).length === 0) {
    throw new Error(`parseSkillFrontmatter: missing frontmatter in ${mdPath}`)
  }

  const front: Record<string, unknown> = parsed.data
  const name = typeof front.name === "string" ? front.name : null
  const desc = typeof front.description === "string" ? front.description : ""

  if (!name) {
    throw new Error(
      `parseSkillFrontmatter: missing or invalid 'name' field in ${mdPath}`,
    )
  }

  return { name, description: desc, dir: skillDir }
}

// ── target resolution ──────────────────────────────────────────────────

const VALID_TARGETS: SkillTarget[] = ["hermes", "claude-code", "claude-desktop"]

function isSkillTarget(t: string): t is SkillTarget {
  return VALID_TARGETS.some((v) => v === t)
}

function resolveTargets(explicit: string[]): SkillTarget[] {
  if (explicit.length > 0) {
    const targets: SkillTarget[] = []
    for (const t of explicit) {
      if (isSkillTarget(t)) {
        targets.push(t)
      } else {
        process.stderr.write(
          `agentproto install skill: unknown target '${t}'. Known: ${VALID_TARGETS.join(", ")}\n`,
        )
      }
    }
    return targets
  }

  // Auto-detect: check which targets are installed on this host.
  // Only hermes and claude-code are phase 1–2 targets.
  return VALID_TARGETS // default: both; actual existence checks happen at install time
}

// ── install actions ────────────────────────────────────────────────────

async function installOne(
  skill: SkillInfo,
  opts: InstallOpts,
): Promise<InstallAction> {
  switch (opts.target) {
    case "hermes":
      return installToHermes(skill, opts)
    case "claude-code":
      return installToClaudeCode(opts)
    case "claude-desktop":
      return installToClaudeDesktop(skill, opts)
  }
}

// ── hermes ─────────────────────────────────────────────────────────────

async function installToHermes(
  skill: SkillInfo,
  opts: InstallOpts,
): Promise<InstallAction> {
  const destDir = join(homedir(), ".hermes", "skills", skill.name)

  // A symlinked skill is a deliberate dev link (edit-in-repo). Never clobber
  // it — `fs.cp` can't overwrite a symlink with a directory anyway
  // (ERR_FS_CP_DIR_TO_NON_DIR). Leave it and tell the user how to replace it.
  if (await isSymlink(destDir)) {
    return {
      target: "hermes",
      status: "skipped",
      label: skill.name,
      detail: `symlinked at ${destDir} — left untouched (remove the link and re-run to replace)`,
    }
  }

  const exists = await pathExists(destDir)
  if (exists) {
    if (opts.dryRun) {
      return {
        target: "hermes",
        status: "dry-run",
        label: skill.name,
        detail: `[dry-run] would overwrite ${destDir}`,
      }
    }
    const overwrite = opts.force || (await promptOverwrite("hermes", skill.name))
    if (!overwrite) {
      return {
        target: "hermes",
        status: "skipped",
        label: skill.name,
        detail: `already exists at ${destDir}`,
      }
    }
    await freshCopyDir(skill.dir, destDir)
    return {
      target: "hermes",
      status: "overwritten",
      label: skill.name,
      detail: destDir,
    }
  }

  if (opts.dryRun) {
    return {
      target: "hermes",
      status: "dry-run",
      label: skill.name,
      detail: `[dry-run] would create ${destDir}`,
    }
  }

  await mkdir(dirname(destDir), { recursive: true })
  await cp(skill.dir, destDir, { recursive: true })
  return {
    target: "hermes",
    status: "created",
    label: skill.name,
    detail: destDir,
  }
}

/** True when `p` exists and is itself a symlink (valid or broken). */
export async function isSymlink(p: string): Promise<boolean> {
  const st = await lstat(p).catch(() => null)
  return st?.isSymbolicLink() ?? false
}

/**
 * Replace `dest` with a fresh copy of the directory `src`. Removes any existing
 * file/dir at `dest` first, so a type mismatch (an old *file* where a directory
 * now goes) can't trip `fs.cp`'s ERR_FS_CP_DIR_TO_NON_DIR, and a stale prior
 * version is fully replaced rather than merged. Callers MUST handle a symlink
 * `dest` (a deliberate dev link) before calling this — `rm` would drop the link.
 */
export async function freshCopyDir(src: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true })
  await mkdir(dirname(dest), { recursive: true })
  await cp(src, dest, { recursive: true })
}

// ── claude-code ────────────────────────────────────────────────────────

/**
 * Claude Code skills are installed as a plugin (the whole pack bundle),
 * not individual skill drops. We copy the plugin pack to `--out` and
 * create a .zip archive, then print install guidance.
 */
async function installToClaudeCode(
  opts: InstallOpts,
): Promise<InstallAction> {
  const packDir = await resolveSkillPackDir()
  if (!packDir) {
    throw new Error("Could not resolve skill pack directory")
  }

  const exists = await pathExists(opts.outDir)

  if (opts.dryRun) {
    let detail = `[dry-run] would emit plugin to ${opts.outDir}`
    if (opts.slug !== "agentproto-pack") {
      detail += ` (whole pack; a plugin is the install unit)`
    }
    return {
      target: "claude-code",
      status: "dry-run",
      label: "agentproto plugin",
      detail,
    }
  }

  if (exists) {
    const overwrite =
      opts.force || (await promptOverwrite("claude-code", "agentproto plugin"))
    if (!overwrite) {
      return {
        target: "claude-code",
        status: "skipped",
        label: "agentproto plugin",
        detail: `already exists at ${opts.outDir}`,
      }
    }
  }

  // Copy the whole plugin bundle
  await mkdir(opts.outDir, { recursive: true })
  await cp(packDir, opts.outDir, { recursive: true, force: true })

  // Create a .zip of the plugin (best-effort — the plugin dir is the
  // canonical artifact; the archive is a convenience, and `zip` may be
  // absent on minimal/Windows environments).
  const zipPath = `${opts.outDir}.zip`
  let zipped = false
  try {
    const zipCode = await spawnInherit("zip", ["-r", "-q", zipPath, opts.outDir])
    zipped = zipCode === 0
    if (!zipped) {
      process.stderr.write(
        `agentproto install skill: warning — 'zip' exited ${zipCode}; emitted the plugin dir without an archive.\n`,
      )
    }
  } catch {
    process.stderr.write(
      "agentproto install skill: warning — 'zip' not found on PATH; emitted the plugin dir without an archive.\n",
    )
  }

  // Print guidance
  const suffix =
    opts.slug !== "agentproto-pack"
      ? " (whole pack emitted — a Claude Code plugin is the install unit)"
      : ""

  process.stdout.write(
    `\nPlugin bundle written to: ${opts.outDir}${suffix}\n` +
      (zipped ? `Archive: ${zipPath}\n` : "") +
      `\n` +
      `To install in Claude Code:\n` +
      `  NOTE: Claude Code plugin installation is via the /plugin marketplace.\n` +
      `  Run \`claude\` interactively, then:\n` +
      `    /plugin marketplace add ${opts.outDir}\n` +
      `  Or if a local plugin path is supported:\n` +
      `    /plugin install ${opts.outDir}\n` +
      `\n` +
      `  Consult Claude Code docs for the exact command — plugin CLI flags\n` +
      `  may vary by version.\n`,
  )

  return {
    target: "claude-code",
    status: exists ? "overwritten" : "created",
    label: "agentproto plugin",
    detail: opts.outDir,
  }
}

// ── claude-desktop ──────────────────────────────────────────────────────

export interface ManifestSkillEntry {
  skillId: string
  name: string
  description: string
  creatorType: string
  // Real Claude Desktop manifests carry `updatedAt: null` for some built-in
  // skills (schedule, setup-cowork…), so this must admit null, not just string.
  updatedAt: string | null
  enabled: boolean
}

export interface SkillsManifest {
  lastUpdated: number
  skills: ManifestSkillEntry[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isManifestEntry(value: unknown): value is ManifestSkillEntry {
  return (
    isRecord(value) &&
    typeof value.skillId === "string" &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    typeof value.creatorType === "string" &&
    (typeof value.updatedAt === "string" || value.updatedAt === null) &&
    typeof value.enabled === "boolean"
  )
}

/**
 * Parse a Claude Desktop skills manifest into a typed registry, or return null
 * when the file is absent, unparseable, or not shaped like a registry.
 *
 * The caller MUST treat null as "leave the manifest untouched" — NEVER as
 * "start fresh and overwrite". A manifest we cannot fully understand is one we
 * must not rewrite, or we would drop the user's other skills. Any single entry
 * failing the shape guard fails the whole load for the same reason.
 *
 * `.filter(isManifestEntry)` keeps the ORIGINAL entry objects (extra fields
 * preserved verbatim on write-back), narrowed to `ManifestSkillEntry[]` with no
 * cast.
 */
export async function loadSkillsManifest(
  manifestPath: string,
): Promise<SkillsManifest | null> {
  let raw: string
  try {
    raw = await readFile(manifestPath, "utf8")
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.skills)) return null
  const skills = parsed.skills.filter(isManifestEntry)
  if (skills.length !== parsed.skills.length) return null
  const lastUpdated =
    typeof parsed.lastUpdated === "number" ? parsed.lastUpdated : 0
  return { lastUpdated, skills }
}

/**
 * Upsert a skill into a Claude Desktop skills manifest BY NAME.
 * - If an entry with the same `name` exists: update its description + updatedAt,
 *   PRESERVE its existing skillId, keep enabled as-is (default true if absent).
 * - Else: append a new entry with a freshly-generated skillId (creatorType "user",
 *   enabled true).
 * Always bumps `lastUpdated`. Returns a NEW object (no mutation of the input).
 * `nowMs` and `newSkillId` are injected so the function is deterministic/testable.
 */
export function upsertSkillManifestEntry(
  manifest: SkillsManifest,
  skill: { name: string; description: string },
  nowMs: number,
  newSkillId: string,
): SkillsManifest {
  const updatedAt = new Date(nowMs).toISOString()
  const skills = [...manifest.skills]
  const idx = skills.findIndex((e) => e.name === skill.name)
  if (idx !== -1) {
    const existing = skills[idx]!
    skills[idx] = {
      skillId: existing.skillId,
      name: existing.name,
      description: skill.description,
      creatorType: existing.creatorType,
      updatedAt,
      enabled: existing.enabled ?? true,
    }
  } else {
    skills.push({
      skillId: newSkillId,
      name: skill.name,
      description: skill.description,
      creatorType: "user",
      updatedAt,
      enabled: true,
    })
  }
  return { lastUpdated: nowMs, skills }
}

/**
 * Install a skill into Claude Desktop's local-agent skills plugin bundle.
 *
 * Claude Desktop stores user-local-agent skills under:
 *   ~/Library/Application Support/Claude/local-agent-mode-sessions/
 *     skills-plugin/<outerUuid>/<innerUuid>/
 *       .claude-plugin/plugin.json
 *       manifest.json
 *       skills/<name>/SKILL.md
 *
 * We discover the existing bundle dir (never fabricate one — Claude Desktop
 * creates it when local-agent skills are enabled), then copy the skill folder
 * into it and upsert its registry entry in `manifest.json`.
 */
async function installToClaudeDesktop(
  skill: SkillInfo,
  opts: InstallOpts,
): Promise<InstallAction> {
  const appSupport = claudeDesktopAppSupportDir()

  // Dry-run: describe what would happen without checking existence.
  // This way `--dry-run` works even when Claude Desktop is not installed.
  if (opts.dryRun) {
    return {
      target: "claude-desktop",
      status: "dry-run",
      label: skill.name,
      detail: `[dry-run] would install skill into Claude Desktop plugin bundle (${appSupport}/local-agent-mode-sessions/skills-plugin/...)`,
    }
  }

  const baseExists = await pathExists(appSupport)
  if (!baseExists) {
    return {
      target: "claude-desktop",
      status: "skipped",
      label: skill.name,
      detail: `Claude Desktop not found at ${appSupport}`,
    }
  }

  const pluginDir = await discoverClaudeSkillsPluginDir(appSupport)
  if (!pluginDir) {
    return {
      target: "claude-desktop",
      status: "skipped",
      label: skill.name,
      detail:
        "Claude Desktop local-agent skills bundle not found. " +
        "Open Claude Desktop → enable local skills first.",
    }
  }

  const destSkillDir = join(pluginDir, "skills", skill.name)
  const manifestPath = join(pluginDir, "manifest.json")

  // Load + validate the existing registry FIRST. discover() guarantees the
  // manifest exists; if we cannot parse it into a registry we skip entirely
  // rather than risk overwriting (and thereby wiping) the user's other skills.
  const manifest = await loadSkillsManifest(manifestPath)
  if (!manifest) {
    return {
      target: "claude-desktop",
      status: "skipped",
      label: skill.name,
      detail: `could not parse Claude Desktop manifest at ${manifestPath}; left it untouched`,
    }
  }

  const existingSkillDir = await pathExists(destSkillDir)
  const existingManifestEntry = manifest.skills.some(
    (e) => e.name === skill.name,
  )
  const exists = existingSkillDir || existingManifestEntry

  // A symlinked skill dir is a deliberate dev link — never clobber it (and
  // `fs.cp` can't overwrite a symlink with a directory anyway).
  if (existingSkillDir && (await isSymlink(destSkillDir))) {
    return {
      target: "claude-desktop",
      status: "skipped",
      label: skill.name,
      detail: `symlinked at ${destSkillDir} — left untouched (remove the link and re-run to replace)`,
    }
  }

  if (exists && !opts.force) {
    const overwrite = await promptOverwrite("claude-desktop", skill.name)
    if (!overwrite) {
      return {
        target: "claude-desktop",
        status: "skipped",
        label: skill.name,
        detail: `already exists in Claude Desktop plugin (${pluginDir})`,
      }
    }
  }

  // Copy skill folder (fresh — replaces any stale prior version cleanly).
  await freshCopyDir(skill.dir, destSkillDir)

  // Backup the manifest before modifying it.
  try {
    await copyFile(manifestPath, `${manifestPath}.bak`)
  } catch {
    // Best-effort — if the backup write fails, still proceed with the upsert.
  }

  const nowMs = Date.now()
  const newId = "skill_local_" + randomUUID().replace(/-/g, "")
  const updated = upsertSkillManifestEntry(manifest, skill, nowMs, newId)
  await writeFile(manifestPath, JSON.stringify(updated, null, 2) + "\n", "utf8")

  return {
    target: "claude-desktop",
    status: exists ? "overwritten" : "created",
    label: skill.name,
    detail: destSkillDir,
  }
}

function claudeDesktopAppSupportDir(): string {
  const home = homedir()
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Claude")
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA
    if (!appData) {
      // should not happen on real Windows, but guard gracefully
      return join(home, "AppData", "Roaming", "Claude")
    }
    return join(appData, "Claude")
  }
  // linux
  return join(home, ".config", "Claude")
}

async function discoverClaudeSkillsPluginDir(
  appSupport: string,
): Promise<string | null> {
  const sessionsDir = join(appSupport, "local-agent-mode-sessions", "skills-plugin")
  let outerEntries: string[]
  try {
    outerEntries = await readdir(sessionsDir)
  } catch {
    return null
  }

  const candidates: { path: string; hasAnthropicName: boolean }[] = []

  for (const outer of outerEntries) {
    const outerPath = join(sessionsDir, outer)
    try {
      const st = await stat(outerPath)
      if (!st.isDirectory()) continue
    } catch {
      continue
    }

    let innerEntries: string[]
    try {
      innerEntries = await readdir(outerPath)
    } catch {
      continue
    }

    for (const inner of innerEntries) {
      const innerPath = join(outerPath, inner)
      try {
        const st = await stat(innerPath)
        if (!st.isDirectory()) continue
      } catch {
        continue
      }

      const hasManifest = await pathExists(join(innerPath, "manifest.json"))
      const hasSkillsDir = await pathExists(join(innerPath, "skills"))
      if (!hasManifest || !hasSkillsDir) continue

      let hasAnthropicName = false
      try {
        const pluginJsonPath = join(
          innerPath,
          ".claude-plugin",
          "plugin.json",
        )
        const raw = await readFile(pluginJsonPath, "utf8")
        const parsed: unknown = JSON.parse(raw)
        if (isRecord(parsed) && parsed.name === "anthropic-skills") {
          hasAnthropicName = true
        }
      } catch {
        // plugin.json missing or unreadable
      }

      candidates.push({ path: innerPath, hasAnthropicName })
    }
  }

  if (candidates.length === 0) return null
  const preferred = candidates.find((c) => c.hasAnthropicName)
  const selected = preferred ?? candidates[0]
  if (!selected) return null
  return selected.path
}

// ── helpers ────────────────────────────────────────────────────────────

/** Check if a path exists (as dir, file, or symlink). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    // Also check for broken symlinks (stat follows, lstat doesn't)
    try {
      await lstat(p)
      return true
    } catch {
      return false
    }
  }
}

/** Prompt the user on stdin: "Skill X already exists in Y. Overwrite? [y/N]" */
async function promptOverwrite(
  label: string,
  name: string,
): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const answer = await new Promise<string>((resolvePromise) => {
    rl.question(
      `Skill "${name}" already exists in ${label}. Overwrite? [y/N] `,
      (a: string) => resolvePromise(a),
    )
  })

  rl.close()
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes"
}

function spawnInherit(
  cmd: string,
  argv: string[],
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, argv, { stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", (code) => resolvePromise(code ?? 0))
  })
}