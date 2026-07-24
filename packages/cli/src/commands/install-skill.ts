/**
 * agentproto install skill/SLUG — install AIP-3 skills from a skill pack
 * into target agents.
 *
 * Pack resolution (see ./skill-install/pack-resolve.ts + fetch-pack.ts):
 *   --pack <path>              → used verbatim (home-expanded)
 *   --pack <name>[@<semver>]   → `~/.agentproto/packs/<name>[@ver]/`, then
 *                                `<repoRoot>/.skills/<name>/`, then the npm
 *                                dual naming convention, then a NETWORK fetch
 *                                of `@agentproto/skill-pack-<name>@<ver|latest>`
 *   --pack npm:<pkg>[@<ver>]   → pinned npm fetch, name derived from <pkg>
 *   --pack github:<o>/<r>[#ref]→ github codeload tarball fetch (test an
 *                                unreleased ref)
 *   (omitted)                  → legacy `.skills/agentproto-plugin-v*` →
 *                                node_modules → fetch npm latest
 *   --refresh                  → bypass the pack cache and re-fetch
 *
 * A fetch materializes the pack into `~/.agentproto/packs/<name>@<ver>/` and
 * updates a `packs/<name>` pointer, so the next resolve is offline.
 *
 * Each skill lives at pack/skills/NAME/ with a SKILL.md + optional assets.
 *
 * Target resolution:
 *   --target <t>    → legacy explicit path: installs directly into that
 *                     target (hermes / claude-code / claude-desktop),
 *                     bypassing adapter discovery entirely. Unchanged
 *                     behavior from earlier phases.
 *   (omitted)       → NEW fan-out: installs into EVERY installed CLI
 *                     adapter that declares a `metadata.skills` block
 *                     (see ./skill-install/types.ts `AdapterSkillsTarget`),
 *                     in addition to whatever skills that driver ships
 *                     natively. Adapters without a `metadata.skills`
 *                     block are skipped with an informational line —
 *                     not an error.
 */

import { join, normalize } from "node:path"
import { parseArgs } from "node:util"
import { homedir } from "node:os"

import { discoverAdapterPackages } from "@agentproto/provider-kit"
import { resolveAdapter } from "../registry/resolve.js"

import {
  type InstallAction,
  type InstallOpts,
  type SkillInfo,
  type SkillInstallHandlerOpts,
  type SkillTarget,
  VALID_TARGETS,
  isAdapterSkillsTarget,
  isSkillTarget,
} from "./skill-install/types.js"
import {
  expandHome,
  listSkills,
  parseSkillFrontmatter,
  resolveSkillPackDir,
} from "./skill-install/pack-resolve.js"
import { installFlatDir } from "./skill-install/flat-dir.js"
import { installClaudePlugin } from "./skill-install/claude-plugin.js"
import { installDesktopBundle } from "./skill-install/desktop-bundle.js"
import { pathExists } from "./skill-install/shared.js"

// ── re-exports for back-compat (tests + other call-sites import these
// pure helpers from "./install-skill.js" — relocating them into
// ./skill-install/* must not change their import path for consumers) ──

export { parseSkillFrontmatter, compareSemver } from "./skill-install/pack-resolve.js"
export { isSymlink, freshCopyDir } from "./skill-install/shared.js"
export {
  loadSkillsManifest,
  upsertSkillManifestEntry,
  type ManifestSkillEntry,
  type SkillsManifest,
} from "./skill-install/desktop-bundle.js"

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
      pack: { type: "string" },
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
      list: { type: "boolean" },
      out: { type: "string" },
      refresh: { type: "boolean" },
    },
  })

  const packArg = values.pack
  const resolveOpts = { allowFetch: true, refresh: values.refresh === true }

  // --list → dump skill names + descriptions and exit
  if (values.list) {
    const packDir = await resolveSkillPackDir(packArg, resolveOpts)
    if (!packDir) {
      process.stderr.write(packNotFoundMessage(packArg))
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

  // Resolve the pack
  const packDir = await resolveSkillPackDir(packArg, resolveOpts)
  if (!packDir) {
    process.stderr.write(packNotFoundMessage(packArg))
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

  const explicitTargets: string[] = values.target ?? []

  if (explicitTargets.length > 0) {
    return runExplicitTargets(explicitTargets, skills, {
      slug: rawSlug,
      force: values.force === true,
      dryRun: values["dry-run"] === true,
      outDir,
      packDir,
    })
  }

  return runFanOut(skills, {
    slug: rawSlug,
    force: values.force === true,
    dryRun: values["dry-run"] === true,
    outDir,
    packDir,
  })
}

function packNotFoundMessage(packArg: string | undefined): string {
  if (packArg && (packArg.startsWith("github:") || packArg.startsWith("npm:"))) {
    // A fetch spec — the fetcher already wrote the specific failure reason
    // (offline, 404, missing built pack) to stderr just above.
    return `agentproto install skill: could not fetch pack '${packArg}' (see the reason above).\n`
  }
  if (packArg) {
    return (
      `agentproto install skill: could not resolve pack '${packArg}'. Looked for:\n` +
      `  ${join(homedir(), ".agentproto", "packs", packArg)}\n` +
      `  <repoRoot>/.skills/${packArg}\n` +
      `  @agentproto/skill-pack-${packArg} (npm)\n` +
      `  @<scope>/agentproto-skill-pack-${packArg} (npm)\n`
    )
  }
  return "agentproto install skill: could not resolve the agentproto skill pack directory.\n"
}

// ── legacy explicit --target path (unchanged behavior) ──────────────────

interface RunOpts {
  slug: string
  force: boolean
  dryRun: boolean
  outDir: string
  packDir: string
}

async function runExplicitTargets(
  explicit: string[],
  skills: SkillInfo[],
  runOpts: RunOpts,
): Promise<number> {
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
  if (targets.length === 0) {
    process.stderr.write(
      "agentproto install skill: no valid targets specified.\n",
    )
    return 2
  }

  const actions: InstallAction[] = []

  for (const target of targets) {
    const opts: InstallOpts = {
      target,
      slug: runOpts.slug,
      force: runOpts.force,
      dryRun: runOpts.dryRun,
      outDir: runOpts.outDir,
    }
    for (const skill of skills) {
      const result = await installOne(skill, opts, runOpts.packDir)
      actions.push(result)
    }
  }

  return printSummaryAndExit(actions)
}

async function installOne(
  skill: SkillInfo,
  opts: InstallOpts,
  packDir: string,
): Promise<InstallAction> {
  const handlerOpts: SkillInstallHandlerOpts = {
    force: opts.force,
    dryRun: opts.dryRun,
    slug: opts.slug,
  }
  switch (opts.target) {
    case "hermes":
      return installFlatDir(
        skill,
        { ...handlerOpts, dir: join(homedir(), ".hermes", "skills") },
        "hermes",
      )
    case "claude-code":
      return installClaudePlugin(
        skill,
        { ...handlerOpts, outDir: opts.outDir, packDir },
        "claude-code",
      )
    case "claude-desktop":
      return installDesktopBundle(skill, handlerOpts, "claude-desktop")
  }
}

// ── fan-out path (new default when no --target is given) ────────────────

async function runFanOut(skills: SkillInfo[], runOpts: RunOpts): Promise<number> {
  const discovered = await discoverAdapterPackages()

  const actions: InstallAction[] = []
  const skippedNotes: string[] = []
  let installedAnywhere = false

  for (const { slug } of discovered) {
    let skillsTarget: unknown
    try {
      const resolved = await resolveAdapter(slug)
      skillsTarget = resolved.handle.metadata?.skills
    } catch {
      skippedNotes.push(`  (skip) ${slug}: adapter package not importable`)
      continue
    }

    if (!isAdapterSkillsTarget(skillsTarget)) {
      skippedNotes.push(`  (skip) ${slug}: no skills metadata declared`)
      continue
    }

    installedAnywhere = true

    if (skillsTarget.format === "flat-dir") {
      const dir = expandHome(skillsTarget.dir ?? "")
      if (!dir) {
        skippedNotes.push(`  (skip) ${slug}: flat-dir target missing 'dir'`)
        continue
      }
      for (const skill of skills) {
        const result = await installFlatDir(
          skill,
          { force: runOpts.force, dryRun: runOpts.dryRun, slug: runOpts.slug, dir },
          slug,
        )
        actions.push(result)
      }
    } else if (skillsTarget.format === "claude-plugin") {
      const outDir = expandHome(skillsTarget.outDir ?? runOpts.outDir)
      // whole-pack: install ONCE regardless of how many skills were requested
      const placeholder = skills[0]
      if (!placeholder) continue
      const result = await installClaudePlugin(
        placeholder,
        {
          force: runOpts.force,
          dryRun: runOpts.dryRun,
          slug: runOpts.slug,
          outDir,
          packDir: runOpts.packDir,
        },
        slug,
      )
      actions.push(result)
    } else if (skillsTarget.format === "desktop-bundle") {
      for (const skill of skills) {
        const result = await installDesktopBundle(
          skill,
          { force: runOpts.force, dryRun: runOpts.dryRun, slug: runOpts.slug },
          slug,
        )
        actions.push(result)
      }
    }
  }

  for (const note of skippedNotes) {
    process.stdout.write(`${note}\n`)
  }

  if (!installedAnywhere) {
    process.stdout.write(
      "No installed adapter declares a skills fan-out target. Nothing installed. " +
        "Pass --target to install into a specific driver directly.\n",
    )
    return 0
  }

  return printSummaryAndExit(actions)
}

// ── summary ────────────────────────────────────────────────────────────

function printSummaryAndExit(actions: InstallAction[]): number {
  if (actions.length === 0) {
    process.stdout.write("Nothing to install.\n")
    return 0
  }

  for (const a of actions) {
    const prefix = a.status === "dry-run" ? "[dry-run] " : ""
    process.stdout.write(`  ${prefix}${a.target}: ${a.label} — ${a.status}\n`)
  }

  const failed = actions.filter(
    (a) =>
      a.status !== "created" &&
      a.status !== "overwritten" &&
      a.status !== "dry-run" &&
      a.status !== "skipped",
  )
  if (failed.length > 0) {
    process.stderr.write(
      `${failed.length} install(s) skipped or failed. See details above.\n`,
    )
  }

  return failed.length === 0 ? 0 : 1
}
