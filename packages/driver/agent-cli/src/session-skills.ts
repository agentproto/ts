/**
 * Per-session skill delivery — the driver half of the skill-imports feature.
 *
 * The daemon resolves imported skills at spawn (see `@agentproto/runtime`'s
 * `resolveSessionSkills`) and hands them down as
 * {@link AgentCliStartOptions.sessionSkills}. This module copies each skill
 * folder into the session's isolated config dir, at a location the ADAPTER
 * declares so its harness discovers the skills natively under its own
 * isolated home:
 *
 *   <adapterConfigDir>/<dir>/<alias>/SKILL.md
 *
 * The location and any env var naming it come from the adapter manifest's
 * `metadata.sessionSkills` field ({@link SessionSkillsMetadata}) — an adapter
 * that declares none gets no delivery (the field is the opt-in). The whole
 * `<dir>` tree is wiped first, so a respawn never leaves a stale skill behind.
 *
 * For opencode this is the only route that survives `lean` mode: the mode sets
 * `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, which gates opencode's AUTO-DISCOVERY
 * of `~/.claude/skills`, `~/.agents/skills`, and project-ancestor `.claude`/
 * `.agents` dirs — but NOT its own config-dir scan. Pointing `OPENCODE_CONFIG_DIR`
 * at the session dir (whose `skills/` we populate) loads the skills regardless
 * of that flag, because opencode's `Skill.discovery` scans every config dir
 * (including `$OPENCODE_CONFIG_DIR`) unconditionally. Verified against the
 * installed opencode 1.18.x/1.19.x binary; see the report.
 */

import { cpSync, mkdirSync, rmSync } from "node:fs"
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path"
import type { AgentCliSessionSkill } from "./types.js"

/** Placeholder an adapter manifest uses in `metadata.sessionSkills.env` values
 *  for "the absolute session config dir" (the base that holds `dir`). */
export const SESSION_SKILLS_ABS_DIR = "<abs dir>"

/** Shape of an adapter manifest's `metadata.sessionSkills`. */
export interface SessionSkillsMetadata {
  /**
   * Skill dir RELATIVE to the session config dir — the copy target is
   * `<adapterConfigDir>/<dir>/<alias>/`. claude-code and opencode both use
   * `"skills"` (the flat one-subdir-per-skill shape).
   */
  dir: string
  /**
   * Env vars to point at the session config dir so the harness discovers the
   * delivered skills under its isolated home. The literal
   * {@link SESSION_SKILLS_ABS_DIR} in a value is substituted with the absolute
   * session config dir. opencode needs `OPENCODE_CONFIG_DIR`; claude-code
   * needs none (`CLAUDE_CONFIG_DIR` is already the session dir).
   */
  env?: Record<string, string>
}

/**
 * Read + validate `metadata.sessionSkills` from an adapter manifest. Returns
 * `undefined` when absent or malformed (an adapter that opts out, or a manifest
 * typo) — delivery is purely additive and must never break a spawn.
 */
export function readSessionSkillsMetadata(
  metadata: Record<string, unknown> | undefined,
): SessionSkillsMetadata | undefined {
  const raw = metadata?.sessionSkills
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const dir = record.dir
  if (typeof dir !== "string" || dir.length === 0) return undefined
  const env: Record<string, string> = {}
  const envRaw = record.env
  if (envRaw && typeof envRaw === "object" && !Array.isArray(envRaw)) {
    for (const [name, value] of Object.entries(envRaw)) {
      if (typeof value === "string") env[name] = value
    }
  }
  return { dir, ...(Object.keys(env).length > 0 ? { env } : {}) }
}

export interface ApplySessionSkillsArgs {
  skills: readonly AgentCliSessionSkill[]
  meta: SessionSkillsMetadata
  /** The absolute session config dir that holds `meta.dir`. */
  baseDir: string
  /** Mutated in place with the resolved `meta.env` entries. */
  env: Record<string, string>
}

export interface ApplySessionSkillsResult {
  /** The delivered skills dir — an extra write path for a confined spawn. */
  targetDir: string
}

/**
 * Copy each skill folder into `<baseDir>/<dir>/<alias>/`, wiping `<dir>` first.
 * A copy (not a symlink) so the delivered tree survives the source moving, and
 * a recursive copy so multi-file skills (`scripts/`, references) come along.
 */
export function applySessionSkills(args: ApplySessionSkillsArgs): ApplySessionSkillsResult {
  const targetDir = join(args.baseDir, args.meta.dir)
  // Wipe stale entries wholesale: a skill removed from the import set (or
  // renamed) must not linger for the next spawn to accidentally discover.
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })
  for (const skill of args.skills) {
    // Defense in depth: the registry validates `alias` as a bare slug, but a
    // hand-edited/corrupt registry could carry `..`/separators — never let a
    // copy escape the target dir.
    const dest = resolvePath(targetDir, skill.alias)
    const rel = relative(targetDir, dest)
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `refusing to deliver skill "${skill.alias}": alias escapes ${targetDir}`,
      )
    }
    cpSync(skill.path, dest, { recursive: true })
  }
  if (args.meta.env) {
    for (const [name, value] of Object.entries(args.meta.env)) {
      args.env[name] = value.split(SESSION_SKILLS_ABS_DIR).join(args.baseDir)
    }
  }
  return { targetDir }
}
