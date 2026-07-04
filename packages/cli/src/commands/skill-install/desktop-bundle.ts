/**
 * desktop-bundle installer — installs a skill into Claude Desktop's
 * local-agent skills plugin bundle. Moved verbatim from the original
 * `installToClaudeDesktop` (only relocated, not generalized — Claude
 * Desktop isn't an adapter package yet, so it stays reachable only via
 * the legacy explicit `--target claude-desktop` path, not the fan-out).
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

import { copyFile, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { homedir } from "node:os"
import { freshCopyDir, isSymlink, pathExists } from "./shared.js"
import { promptOverwrite } from "./shared.js"
import type { SkillInstallHandler } from "./types.js"

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

export const installDesktopBundle: SkillInstallHandler = async (skill, opts, target) => {
  const appSupport = claudeDesktopAppSupportDir()

  // Dry-run: describe what would happen without checking existence.
  // This way `--dry-run` works even when Claude Desktop is not installed.
  if (opts.dryRun) {
    return {
      target,
      status: "dry-run",
      label: skill.name,
      detail: `[dry-run] would install skill into Claude Desktop plugin bundle (${appSupport}/local-agent-mode-sessions/skills-plugin/...)`,
    }
  }

  const baseExists = await pathExists(appSupport)
  if (!baseExists) {
    return {
      target,
      status: "skipped",
      label: skill.name,
      detail: `Claude Desktop not found at ${appSupport}`,
    }
  }

  const pluginDir = await discoverClaudeSkillsPluginDir(appSupport)
  if (!pluginDir) {
    return {
      target,
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
      target,
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
      target,
      status: "skipped",
      label: skill.name,
      detail: `symlinked at ${destSkillDir} — left untouched (remove the link and re-run to replace)`,
    }
  }

  if (exists && !opts.force) {
    const overwrite = await promptOverwrite(target, skill.name)
    if (!overwrite) {
      return {
        target,
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
    target,
    status: exists ? "overwritten" : "created",
    label: skill.name,
    detail: destSkillDir,
  }
}
