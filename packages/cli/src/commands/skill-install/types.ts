/**
 * Shared types for the `agentproto install skill/<slug>` verb and its
 * per-format installer handlers (flat-dir / claude-plugin /
 * desktop-bundle). Kept in one place so `install-skill.ts` (the CLI
 * orchestrator) and each handler module agree on shape without
 * duplicating declarations.
 */

// ── legacy explicit --target enum (still the only values `--target` accepts) ──

export type SkillTarget = "hermes" | "claude-code" | "claude-desktop"

export const VALID_TARGETS: SkillTarget[] = [
  "hermes",
  "claude-code",
  "claude-desktop",
]

export function isSkillTarget(t: string): t is SkillTarget {
  return VALID_TARGETS.some((v) => v === t)
}

// ── skill data ─────────────────────────────────────────────────────────

export interface SkillInfo {
  name: string
  description: string
  dir: string
}

// ── install plumbing ───────────────────────────────────────────────────

export interface InstallOpts {
  target: SkillTarget
  slug: string
  force: boolean
  dryRun: boolean
  outDir: string
}

export interface InstallAction {
  /** Legacy target name ("hermes" / "claude-code" / "claude-desktop") for
   *  the explicit --target path, or the discovered adapter slug for the
   *  fan-out path. Free-form string so fan-out isn't limited to the
   *  legacy three. */
  target: string
  status: "created" | "overwritten" | "skipped" | "dry-run"
  label: string
  detail: string
}

/**
 * Per-format installer signature shared by every skill-install handler.
 * A handler only reads the fields relevant to its format:
 *   - flat-dir:      `dir` (the skills directory to copy into, one subdir
 *                     per skill).
 *   - claude-plugin: `outDir` (where the plugin bundle is emitted) and
 *                     `packDir` (the whole pack directory being emitted —
 *                     this format installs the WHOLE PACK, not per-skill).
 *   - desktop-bundle: neither — it locates Claude Desktop's own bundle
 *                     dir itself.
 */
export interface SkillInstallHandlerOpts {
  force: boolean
  dryRun: boolean
  slug: string
  dir?: string
  outDir?: string
  packDir?: string
}

export type SkillInstallHandler = (
  skill: SkillInfo,
  opts: SkillInstallHandlerOpts,
  target: string,
) => Promise<InstallAction>

// ── adapter metadata.skills (fan-out target declaration) ────────────────

export type AdapterSkillsFormat = "flat-dir" | "claude-plugin" | "desktop-bundle"

/**
 * The shape an adapter declares at `metadata.skills` (untyped
 * `Record<string, unknown>` on `AgentCliDefinition` today — see the
 * `metadata?` field on `AgentCliDefinition` in
 * `packages/driver/agent-cli/src/types.ts`) to opt into skill fan-out.
 *
 * NOT promoted to a first-class typed AIP-45 field yet (that needs a
 * coordinated driver release) — `isAdapterSkillsTarget` below is the
 * runtime shape guard consumers must use instead of trusting the
 * untyped metadata bag.
 */
export interface AdapterSkillsTarget {
  format: AdapterSkillsFormat
  /** flat-dir only — the directory skills get copied into (one subdir
   *  per skill name). May contain `~` for home-dir expansion. */
  dir?: string
  /** claude-plugin only — where the plugin bundle is emitted. May
   *  contain `~` for home-dir expansion. */
  outDir?: string
  /** claude-plugin declares "whole-pack": the pack is installed once,
   *  not once per requested skill slug. */
  unit?: "whole-pack"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAdapterSkillsFormat(value: unknown): value is AdapterSkillsFormat {
  return value === "flat-dir" || value === "claude-plugin" || value === "desktop-bundle"
}

/**
 * Runtime shape guard for an adapter's `metadata.skills` value. Returns
 * false for anything not shaped like an `AdapterSkillsTarget` — callers
 * must treat a false result as "this adapter doesn't opt into fan-out",
 * never throw.
 */
export function isAdapterSkillsTarget(value: unknown): value is AdapterSkillsTarget {
  if (!isRecord(value)) return false
  if (!isAdapterSkillsFormat(value.format)) return false
  if (value.dir !== undefined && typeof value.dir !== "string") return false
  if (value.outDir !== undefined && typeof value.outDir !== "string") return false
  if (value.unit !== undefined && value.unit !== "whole-pack") return false
  return true
}
