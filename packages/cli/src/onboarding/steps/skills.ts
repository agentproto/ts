/**
 * skills — is the agentproto skill pack installed into each adapter that
 * declares a skills fan-out target (the same resolution `agentproto install
 * skill/agentproto-pack` uses), and is it current against the pack that
 * resolves locally (or, failing that, the published one).
 */

import { join } from "node:path"
import { compareVersions } from "@agentproto/runtime/release-check"
import type { SkillFanOutTarget } from "../../commands/install-skill.js"
import type { OnboardingStep, StepCheck, StepContext } from "../types.js"
import { errorMessage, expandHome, pathExists, readManifestVersion, tildify } from "./_util.js"

const INSTALL_FIX = "agentproto install skill/agentproto-pack"

interface PackInfo {
  /** Version to compare against, or `null` when unknown. */
  version: string | null
  /** Where `version` came from. */
  source: "local" | "npm" | "unknown"
  /** Skill names in the local pack (`null` when no local pack resolves). */
  skills: string[] | null
}

async function packInfo(ctx: StepContext): Promise<PackInfo> {
  const dir = await ctx.sources.resolveSkillPackDir().catch(() => null)
  if (dir) {
    const version =
      (await readManifestVersion(ctx, join(dir, ".claude-plugin", "plugin.json"))) ??
      (await readManifestVersion(ctx, join(dir, "package.json")))
    let names: string[] = []
    try {
      names = await ctx.fs.readdir(join(dir, "skills"))
    } catch {
      names = []
    }
    const skills: string[] = []
    for (const name of names) {
      if (await pathExists(ctx, join(dir, "skills", name, "SKILL.md"))) skills.push(name)
    }
    return { version, source: "local", skills }
  }
  const latest = await ctx.sources.latestSkillPackVersion().catch(() => null)
  return { version: latest, source: latest ? "npm" : "unknown", skills: null }
}

async function checkClaudePlugin(ctx: StepContext, t: SkillFanOutTarget, pack: PackInfo): Promise<StepCheck> {
  const id = `skills.${t.slug}`
  const outDir = t.target.outDir ? expandHome(ctx, t.target.outDir) : null
  if (!outDir) {
    return { id, title: t.slug, status: "warn", detail: "not checked: skills target declares no outDir" }
  }
  const installed = await readManifestVersion(ctx, join(outDir, ".claude-plugin", "plugin.json"))
  const data = { format: t.target.format, path: outDir, installed, available: pack.version, availableFrom: pack.source }
  if (installed === null) {
    return { id, title: t.slug, status: "warn", detail: `agentproto plugin not installed at ${tildify(ctx, outDir)}`, fix: INSTALL_FIX, data }
  }
  if (pack.version && compareVersions(pack.version, installed) > 0) {
    return {
      id,
      title: t.slug,
      status: "warn",
      detail: `plugin v${installed} is older than the pack v${pack.version}`,
      fix: `${INSTALL_FIX} --force`,
      data,
    }
  }
  return { id, title: t.slug, status: "ok", detail: `plugin v${installed} at ${tildify(ctx, outDir)}`, data }
}

async function checkFlatDir(ctx: StepContext, t: SkillFanOutTarget, pack: PackInfo): Promise<StepCheck> {
  const id = `skills.${t.slug}`
  const dir = t.target.dir ? expandHome(ctx, t.target.dir) : null
  if (!dir) {
    return { id, title: t.slug, status: "warn", detail: "not checked: skills target declares no dir" }
  }
  if (pack.skills === null) {
    return {
      id,
      title: t.slug,
      status: "warn",
      detail: "not checked: the skill pack does not resolve locally to compare against",
      data: { format: t.target.format, path: dir },
    }
  }
  const present: string[] = []
  for (const name of pack.skills) {
    if (await pathExists(ctx, join(dir, name, "SKILL.md"))) present.push(name)
  }
  const missing = pack.skills.filter((s) => !present.includes(s))
  const data = { format: t.target.format, path: dir, present: present.length, total: pack.skills.length, missing }
  if (present.length === 0) {
    return { id, title: t.slug, status: "warn", detail: `skill pack not installed in ${tildify(ctx, dir)}`, fix: INSTALL_FIX, data }
  }
  if (missing.length > 0) {
    return {
      id,
      title: t.slug,
      status: "warn",
      detail: `${present.length}/${pack.skills.length} pack skills present (stale install)`,
      fix: INSTALL_FIX,
      data,
    }
  }
  return { id, title: t.slug, status: "ok", detail: `all ${pack.skills.length} pack skills in ${tildify(ctx, dir)}`, data }
}

export const skillsStep: OnboardingStep = {
  id: "skills",
  title: "Skills",
  required: false,
  timeoutMs: 15_000,
  async detect(ctx) {
    let targets: SkillFanOutTarget[]
    try {
      targets = await ctx.sources.skillTargets()
    } catch (err) {
      return [{ id: "skills.targets", title: "Skill targets", status: "warn", detail: `not checked: ${errorMessage(err)}` }]
    }
    if (targets.length === 0) {
      return [{ id: "skills.targets", title: "Skill targets", status: "skipped", detail: "no installed adapter declares a skills target" }]
    }
    const pack = await packInfo(ctx)
    const checks: StepCheck[] = []
    for (const t of targets) {
      switch (t.target.format) {
        case "claude-plugin":
          checks.push(await checkClaudePlugin(ctx, t, pack))
          break
        case "flat-dir":
          checks.push(await checkFlatDir(ctx, t, pack))
          break
        case "desktop-bundle":
          checks.push({
            id: `skills.${t.slug}`,
            title: t.slug,
            status: "warn",
            detail: "not checked: desktop-bundle installs are not inspected yet",
          })
          break
      }
    }
    return checks
  },
}
