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

import { cp, lstat, mkdir, readdir, readFile, stat } from "node:fs/promises"
import { createInterface } from "node:readline"
import { dirname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { parseArgs } from "node:util"
import { homedir } from "node:os"
import matter from "gray-matter"

// ── types ──────────────────────────────────────────────────────────────

type SkillTarget = "hermes" | "claude-code"

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
  scope: "user" | "project"
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
      user: { type: "boolean" },
      project: { type: "boolean" },
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
  const explicitTargets = (values.target ?? []) as string[]
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
    const fm = await parseSkillFrontmatter(skillDir)
    skills = [fm]
  }

  const outDir = values.out
    ? normalize(values.out)
    : join(process.cwd(), "agentproto-skill-plugin")

  const scope: "user" | "project" = values.user
    ? "user"
    : values.project !== false
      ? "project"
      : "project"

  const actions: InstallAction[] = []

  for (const target of targets) {
    const opts: InstallOpts = {
      target,
      slug: rawSlug,
      force: values.force === true,
      dryRun: values["dry-run"] === true,
      outDir,
      scope,
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
    (a) => a.status !== "created" && a.status !== "overwritten" && a.status !== "dry-run",
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
function compareSemver(a: string, b: string): number {
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
async function parseSkillFrontmatter(skillDir: string): Promise<SkillInfo> {
  const mdPath = join(skillDir, "SKILL.md")
  const raw = await readFile(mdPath, "utf8")
  const parsed = matter(raw)

  if (Object.keys(parsed.data).length === 0) {
    throw new Error(`parseSkillFrontmatter: missing frontmatter in ${mdPath}`)
  }

  const front = parsed.data as Record<string, unknown>
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

const VALID_TARGETS: SkillTarget[] = ["hermes", "claude-code"]

function resolveTargets(explicit: string[]): SkillTarget[] {
  if (explicit.length > 0) {
    const targets: SkillTarget[] = []
    for (const t of explicit) {
      if (VALID_TARGETS.includes(t as SkillTarget)) {
        targets.push(t as SkillTarget)
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
  }
}

// ── hermes ─────────────────────────────────────────────────────────────

async function installToHermes(
  skill: SkillInfo,
  opts: InstallOpts,
): Promise<InstallAction> {
  const destDir = join(homedir(), ".hermes", "skills", skill.name)

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
    await cp(skill.dir, destDir, { recursive: true, force: true })
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

  // Create a .zip of the plugin
  const zipPath = `${opts.outDir}.zip`
  const zipCode = await spawnInherit("zip", [
    "-r",
    "-q",
    zipPath,
    opts.outDir,
  ])
  if (zipCode !== 0) {
    process.stderr.write(
      `agentproto install skill: warning — could not create zip, zip exited ${zipCode}\n`,
    )
  }

  // Print guidance
  const suffix =
    opts.slug !== "agentproto-pack"
      ? " (whole pack emitted — a Claude Code plugin is the install unit)"
      : ""

  process.stdout.write(
    `\nPlugin bundle written to: ${opts.outDir}${suffix}\n` +
      `Archive: ${zipPath}\n` +
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