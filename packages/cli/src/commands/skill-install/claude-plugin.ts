/**
 * claude-plugin installer — Claude Code skills are installed as a plugin
 * (the whole pack bundle), not individual skill drops. We copy the plugin
 * pack to `opts.outDir` and create a .zip archive, then print install
 * guidance. Generalized from the original `installToClaudeCode` — the
 * pack dir and output dir now travel through `opts.packDir` / `opts.outDir`
 * instead of re-resolving the legacy default pack internally, so any
 * `--pack` and any adapter declaring
 * `metadata.skills = { format: "claude-plugin", unit: "whole-pack", outDir: "..." }`
 * can reuse it.
 *
 * This format installs the WHOLE PACK, once — callers doing skill
 * fan-out across multiple requested slugs must dedupe and call this
 * exactly once per adapter, not once per skill.
 */

import { cp, mkdir } from "node:fs/promises"
import { pathExists, promptOverwrite } from "./shared.js"
import { zipPackDir } from "./zip-pack.js"
import type { SkillInstallHandler } from "./types.js"

export const installClaudePlugin: SkillInstallHandler = async (skill, opts, target) => {
  const packDir = opts.packDir
  const outDir = opts.outDir
  if (!packDir || !outDir) {
    throw new Error(`installClaudePlugin: missing 'packDir'/'outDir' for target '${target}'`)
  }

  const exists = await pathExists(outDir)

  if (opts.dryRun) {
    let detail = `[dry-run] would emit plugin to ${outDir}`
    if (opts.slug !== "agentproto-pack") {
      detail += ` (whole pack; a plugin is the install unit)`
    }
    return {
      target,
      status: "dry-run",
      label: "agentproto plugin",
      detail,
    }
  }

  if (exists) {
    const overwrite =
      opts.force || (await promptOverwrite(target, "agentproto plugin"))
    if (!overwrite) {
      return {
        target,
        status: "skipped",
        label: "agentproto plugin",
        detail: `already exists at ${outDir}`,
      }
    }
  }

  // Copy the whole plugin bundle
  await mkdir(outDir, { recursive: true })
  await cp(packDir, outDir, { recursive: true, force: true })

  // Create a .zip of the plugin (best-effort — the plugin dir is the
  // canonical artifact; the archive is a convenience, and `zip` may be
  // absent on minimal/Windows environments).
  const { zipped, zipPath } = await zipPackDir(outDir)
  if (!zipped) {
    process.stderr.write(
      "agentproto install skill: warning — 'zip' failed or is not on PATH; emitted the plugin dir without an archive.\n",
    )
  }

  // Print guidance
  const suffix =
    opts.slug !== "agentproto-pack"
      ? " (whole pack emitted — a Claude Code plugin is the install unit)"
      : ""

  process.stdout.write(
    `\nPlugin bundle written to: ${outDir}${suffix}\n` +
      (zipped ? `Archive: ${zipPath}\n` : "") +
      `\n` +
      `To install in Claude Code:\n` +
      `  NOTE: Claude Code plugin installation is via the /plugin marketplace.\n` +
      `  Run \`claude\` interactively, then:\n` +
      `    /plugin marketplace add ${outDir}\n` +
      `  Or if a local plugin path is supported:\n` +
      `    /plugin install ${outDir}\n` +
      `\n` +
      `  Consult Claude Code docs for the exact command — plugin CLI flags\n` +
      `  may vary by version.\n`,
  )

  return {
    target,
    status: exists ? "overwritten" : "created",
    label: "agentproto plugin",
    detail: outDir,
  }
}
