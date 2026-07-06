/**
 * agentproto pack skill — generate a versioned skill pack from a manifest
 * of source skills, the reverse of `agentproto install skill/<slug>`.
 *
 * Manifest format (JSON):
 * ```json
 * {
 *   "name": "agentproto-plugin",
 *   "description": "Operate and supervise a fleet ...",
 *   "version": "0.3.0",
 *   "skills": ["slug1", "slug2", ...],
 *   "sourceDir": "../../.claude/skills",   // optional; omit when source lives in a private/external repo
 *   "author": { "name": "Name" },
 *   "keywords": ["kw1", "kw2", ...]
 * }
 * ```
 *
 * For each listed skill the tool resolves <sourceDir>/<skill>/ relative to
 * the manifest file's own directory (or uses --source when provided),
 * copies the entire skill directory into
 * <outDir>/<name>-v<version>/skills/<skill>/, reads each SKILL.md's YAML
 * frontmatter, regenerates .claude-plugin/plugin.json and README.md, and
 * appends a changelog entry when the version is bumped.
 *
 * When the manifest's sourceDir lives in a *different* git repo from the
 * packager itself (e.g. agentik-studio/.claude/skills vs agentproto/ts),
 * relative resolution will fail. Two portable options, in precedence order:
 *   1. --source <absolute> — one-off override, wins over everything.
 *   2. sourceDir: "${SOME_ENV_VAR}/.claude/skills" — the manifest expands
 *      `${VAR}` against the environment before resolving, so the same
 *      manifest works on any machine that sets that var (e.g.
 *      AGENTIK_STUDIO_ROOT=/path/to/agentik-studio in your shell profile).
 *      Referencing an unset var is a hard error, not a silent path.
 *
 * Relationship to install-skill.ts:
 *   pack skill (this)    → assembles a versioned pack directory from source
 *   install skill/<slug> → consumes a pack directory and installs into targets
 */

import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"

import {
  compareSemver,
  expandHome,
  parseSkillFrontmatter,
} from "./skill-install/pack-resolve.js"
import { pathExists } from "./skill-install/shared.js"
import type { SkillInfo } from "./skill-install/types.js"

// ── types ────────────────────────────────────────────────────────────────

/**
 * Expands `${VAR}` references in a manifest sourceDir against process.env.
 * An unset var is a hard error — a silently-empty substitution would turn
 * into a confusing "SOURCE MISSING" for an unrelated-looking path.
 */
function expandEnvVars(input: string): string {
  return input.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
    const value = process.env[name]
    if (value === undefined) {
      throw new Error(
        `agentproto pack skill: manifest sourceDir references \${${name}}, but that environment variable is not set.`,
      )
    }
    return value
  })
}

interface PackManifest {
  name: string
  description: string
  version: string
  skills: string[]
  sourceDir?: string
  author: { name: string }
  keywords: string[]
}

interface CliArgs {
  manifest: string
  source?: string
  bump?: "patch" | "minor" | "major"
  dryRun: boolean
  out: string
}

type BumpKind = "patch" | "minor" | "major"

// ── re-exports for testing ───────────────────────────────────────────────

export { compareSemver } from "./skill-install/pack-resolve.js"
export { bumpSemver, readManifest }

// ── public entry ─────────────────────────────────────────────────────────

export async function runPack(args: readonly string[]): Promise<number> {
  const subVerb = args.find((a) => !a.startsWith("-"))
  if (subVerb === "skill") {
    return runPackSkill(args.filter((a) => a !== subVerb))
  }

  // No sub-verb or unknown sub-verb
  process.stderr.write(
      `agentproto pack: unknown sub-command${subVerb ? " '" + subVerb + "'" : ""}.\n` +
      "Usage: agentproto pack skill --manifest <path> [--source <dir>] [--bump patch|minor|major] [--dry-run] [--out <dir>]\n",
  )
  return 2
}

export async function runPackSkill(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      manifest: { type: "string" },
      source: { type: "string" },
      bump: { type: "string" },
      "dry-run": { type: "boolean" },
      out: { type: "string", default: ".skills" },
    },
  })

  if (!values.manifest) {
    process.stderr.write(
      "agentproto pack skill: --manifest <path> is required.\n",
    )
    return 2
  }

  const bumpRaw = values.bump
  if (
    bumpRaw !== undefined &&
    bumpRaw !== "patch" &&
    bumpRaw !== "minor" &&
    bumpRaw !== "major"
  ) {
    process.stderr.write(
      "agentproto pack skill: --bump must be one of: patch, minor, major.\n",
    )
    return 2
  }
  const bump = bumpRaw as BumpKind | undefined

  const dryRun = values["dry-run"] === true

  // Resolve manifest path relative to cwd
  const manifestPath = resolve(process.cwd(), values.manifest)
  if (!(await pathExists(manifestPath))) {
    process.stderr.write(
      `agentproto pack skill: manifest not found: ${manifestPath}\n`,
    )
    return 1
  }

  const manifest: PackManifest = await readManifest(manifestPath)
  const manifestDir = dirname(manifestPath)

  if (!values.source && !manifest.sourceDir) {
    process.stderr.write(
      "agentproto pack skill: no source directory. " +
        "Either add sourceDir to the manifest or pass --source <absolute-path>.\n",
    )
    return 2
  }

  const sourceDir = values.source
    ? resolve(process.cwd(), expandHome(values.source))
    : resolve(manifestDir, expandEnvVars(manifest.sourceDir as string))
  const outDir = resolve(process.cwd(), values.out)

  // Determine the effective version
  let version = manifest.version
  const existingVersionDir = await resolveCurrentVersionDir(
    outDir,
    manifest.name,
  )
  let previousVersion: string | undefined
  if (existingVersionDir) {
    const verMatch = existingVersionDir.match(/-v(\d+\.\d+\.\d+)$/)
    if (verMatch) previousVersion = verMatch[1]
  }

  if (bump) {
    version = bumpSemver(previousVersion ?? version, bump)
  } else {
    // Use the manifest's version; if there's already a same-version dir it's a resync
    version = manifest.version
  }

  const packDirName = `${manifest.name}-v${version}`
  const packDir = join(outDir, packDirName)

  if (dryRun) {
    return runDryRun(manifest, packDir, sourceDir, previousVersion, version, bump)
  }

  // 1. Copy each skill directory from source into the pack
  const skills = await copySkills(sourceDir, packDir, manifest.skills)

  // 2. Generate .claude-plugin/plugin.json
  await generatePluginJson(packDir, manifest, version)

  // 3. Generate or update README.md
  // Read from any existing version dir to preserve prose sections
  // and previous changelog entries (read happens before write so
  // same-version resync works correctly).
  const previousReadmePath = existingVersionDir
    ? join(existingVersionDir, "README.md")
    : undefined
  const oldChangelog = previousReadmePath
    ? await extractChangelog(previousReadmePath)
    : undefined
  const oldProse = previousReadmePath
    ? await extractProseSection(previousReadmePath)
    : undefined

  await generateReadme(packDir, manifest, version, skills, oldProse, oldChangelog, bump)

  process.stdout.write(
    `agentproto: pack written to ${packDir}\n` +
      `  ${skills.length} skill(s) copied\n` +
      `  version ${version}${bump ? ` (bumped from ${previousVersion ?? manifest.version})` : existingVersionDir ? " (in-place resync)" : ""}\n`,
  )

  return 0
}

// ── manifest reading ─────────────────────────────────────────────────────

async function readManifest(path: string): Promise<PackManifest> {
  const raw = await readFile(path, "utf8")
  const data: Record<string, unknown> = JSON.parse(raw)

  if (
    typeof data.name !== "string" ||
    typeof data.description !== "string" ||
    typeof data.version !== "string" ||
    !Array.isArray(data.skills)
  ) {
    throw new Error(
      `pack manifest: missing or invalid required fields. ` +
        "Required: name (string), description (string), version (string), skills (array).",
    )
  }

  if (data.sourceDir !== undefined && typeof data.sourceDir !== "string") {
    throw new Error("pack manifest: sourceDir must be a string when present.")
  }

  if (!data.skills.every((s) => typeof s === "string")) {
    throw new Error("pack manifest: skills must be an array of strings.")
  }

  const author =
    data.author && typeof data.author === "object" && !Array.isArray(data.author)
      ? (data.author as { name: string })
      : { name: "agentproto" }
  if (typeof author.name !== "string") {
    author.name = "agentproto"
  }

  const keywords = Array.isArray(data.keywords)
    ? (data.keywords as string[]).filter((k) => typeof k === "string")
    : []

  return {
    name: data.name,
    description: data.description,
    version: data.version,
    skills: data.skills as string[],
    ...(typeof data.sourceDir === "string" ? { sourceDir: data.sourceDir } : {}),
    author,
    keywords,
  }
}

// ── version resolution ───────────────────────────────────────────────────

async function resolveCurrentVersionDir(
  outDir: string,
  packName: string,
): Promise<string | null> {
  if (!(await pathExists(outDir))) return null

  let entries: string[]
  try {
    entries = await readdir(outDir)
  } catch {
    return null
  }

  const prefix = `${packName}-v`
  const candidates: { version: string; path: string }[] = []

  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    const version = entry.slice(prefix.length)
    if (!/^\d+\.\d+\.\d+/.test(version)) continue
    const fullPath = join(outDir, entry)
    try {
      const s = await stat(fullPath)
      if (s.isDirectory()) {
        candidates.push({ version, path: fullPath })
      }
    } catch {
      // skip
    }
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => compareSemver(b.version, a.version))
  return candidates[0]?.path ?? null
}

function bumpSemver(current: string, kind: BumpKind): string {
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return current
  let major = Number(m[1])
  let minor = Number(m[2])
  let patch = Number(m[3])
  switch (kind) {
    case "major":
      major += 1
      minor = 0
      patch = 0
      break
    case "minor":
      minor += 1
      patch = 0
      break
    case "patch":
      patch += 1
      break
  }
  return `${major}.${minor}.${patch}`
}

// ── skill copying ────────────────────────────────────────────────────────

async function copySkills(
  sourceDir: string,
  packDir: string,
  skillSlugs: string[],
): Promise<SkillInfo[]> {
  const results: SkillInfo[] = []

  for (const slug of skillSlugs) {
    const srcSkillDir = join(sourceDir, slug)
    const srcSkillMd = join(srcSkillDir, "SKILL.md")

    if (!(await pathExists(srcSkillMd))) {
      process.stderr.write(
        `agentproto pack skill: source skill not found: ${srcSkillMd}\n`,
      )
      process.exitCode = 1
      throw new Error(`source skill not found: ${slug} at ${srcSkillDir}`)
    }

    const destSkillDir = join(packDir, "skills", slug)
    await rm(destSkillDir, { recursive: true, force: true })
    await mkdir(dirname(destSkillDir), { recursive: true })
    await cp(srcSkillDir, destSkillDir, { recursive: true })

    const fm = await parseSkillFrontmatter(destSkillDir)
    results.push(fm)
  }

  return results
}

// ── plugin.json ──────────────────────────────────────────────────────────

async function generatePluginJson(
  packDir: string,
  manifest: PackManifest,
  version: string,
): Promise<void> {
  const pluginDir = join(packDir, ".claude-plugin")
  await mkdir(pluginDir, { recursive: true })

  const plugin = {
    name: manifest.name,
    version,
    description: manifest.description,
    author: manifest.author,
    keywords: manifest.keywords,
  }

  await writeFile(
    join(pluginDir, "plugin.json"),
    JSON.stringify(plugin, null, 2) + "\n",
    "utf8",
  )
}

// ── README ───────────────────────────────────────────────────────────────

async function extractProseSection(readmePath: string): Promise<string | null> {
  try {
    const content = await readFile(readmePath, "utf8")
    const howItWorksIdx = content.indexOf("## How it works")
    if (howItWorksIdx === -1) return null
    const changelogIdx = content.indexOf("## Changelog", howItWorksIdx)
    return changelogIdx === -1
      ? content.slice(howItWorksIdx).trim()
      : content.slice(howItWorksIdx, changelogIdx).trim()
  } catch {
    return null
  }
}

async function extractChangelog(readmePath: string): Promise<string | null> {
  try {
    const content = await readFile(readmePath, "utf8")
    const idx = content.indexOf("## Changelog")
    if (idx === -1) return null
    return content.slice(idx).trim()
  } catch {
    return null
  }
}

async function generateReadme(
  packDir: string,
  manifest: PackManifest,
  version: string,
  skills: SkillInfo[],
  oldProse: string | null | undefined,
  oldChangelog: string | null | undefined,
  bump: BumpKind | undefined,
): Promise<void> {
  const lines: string[] = []

  // Title
  lines.push(
    `# ${manifest.name} — ${version}`,
    "",
    manifest.description,
    "",
  )

  // Table
  lines.push("## What's inside", "")
  lines.push("| Skill | Description |")
  lines.push("|-------|-------------|")
  for (const skill of skills) {
    const desc = skill.description
      .replace(/\s+/g, " ")
      .replace(/[|]/g, "\\|")
      .slice(0, 120)
    lines.push(`| **${skill.name}** | ${desc} |`)
  }
  lines.push("")

  // Prose section from previous README (How it works / Layering)
  if (oldProse) {
    lines.push(oldProse, "")
  }

  // Changelog
  lines.push("## Changelog", "")
  if (bump) {
    lines.push(`- **${version}** — TODO: describe changes`, "")
  }
  if (oldChangelog) {
    // Remove the "## Changelog" header from the old content (we already have it)
    const oldEntries = oldChangelog
      .replace(/^## Changelog\s*\n*/, "")
      .trim()
    if (oldEntries) {
      lines.push(oldEntries, "")
    }
  }

  // Remove trailing blank lines, keep single one
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop()
  }
  lines.push("") // one trailing newline

  await writeFile(join(packDir, "README.md"), lines.join("\n"), "utf8")
}

// ── dry-run ──────────────────────────────────────────────────────────────

async function runDryRun(
  manifest: PackManifest,
  packDir: string,
  sourceDir: string,
  previousVersion: string | undefined,
  newVersion: string,
  bump: BumpKind | undefined,
): Promise<number> {
  const out = [`[dry-run] agentproto pack skill`]

  if (bump) {
    out.push(
      `  version: ${previousVersion ?? manifest.version} → ${newVersion} (${bump})`,
    )
  } else if (previousVersion) {
    out.push(`  version: ${newVersion} (in-place resync)`)
  } else {
    out.push(`  version: ${newVersion} (fresh)`)
  }

  out.push(`  output: ${packDir}`)
  out.push(`  source: ${sourceDir}`)
  out.push(`  skills:`)
  for (const slug of manifest.skills) {
    const src = join(sourceDir, slug, "SKILL.md")
    const exists = await pathExists(src)
    const dest = join(packDir, "skills", slug)
    const existsInPack = await pathExists(join(dest, "SKILL.md"))
    if (!exists) {
      out.push(`    ❌ ${slug} — SOURCE MISSING`)
    } else if (existsInPack) {
      out.push(`    ~ ${slug} — will overwrite`)
    } else {
      out.push(`    + ${slug} — will copy`)
    }
  }

  process.stdout.write(out.join("\n") + "\n")
  return 0
}
