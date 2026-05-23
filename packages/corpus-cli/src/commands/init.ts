/**
 * `corpus init <slug> [path]` — scaffold a starter workspace from a
 * preset declared by one of the configured corpus-preset packages.
 *
 * The CLI discovers presets via manifests:
 *
 *   - Default: scans `@agentproto/corpus-presets`.
 *   - Configurable: `corpusPresetPackages[]` in `~/.agentproto/config.json`
 *     lets third parties add their own packages (e.g.
 *     `@vendor/corpus-presets`) to the discovery set.
 *
 * `corpus init --list` prints every preset visible to the current
 * configuration before scaffolding anything.
 */

import {
  discoverPresets,
  loadPreset,
} from "../registry/preset-loader.js"
import { NodeFsAdapter } from "../ports/local-fs.adapter.js"
import { fail, resolveWorkspacePath, type ExitCode } from "./_shared.js"

export async function runInit(args: readonly string[]): Promise<ExitCode> {
  const positionals: string[] = []
  let listOnly = false
  for (const a of args) {
    if (a === "--list" || a === "-l") {
      listOnly = true
      continue
    }
    positionals.push(a)
  }

  if (listOnly) {
    return runList()
  }

  const [slug, pathArg] = positionals
  if (!slug) {
    const available = await formatAvailable()
    return fail(
      `init requires a <slug> argument.\n${available}`,
      2
    )
  }

  const preset = await loadPreset(slug)
  if (!preset) {
    const available = await formatAvailable()
    return fail(
      `init: preset "${slug}" not found in any configured package.\n${available}`,
      2
    )
  }

  const target = resolveWorkspacePath(pathArg)
  const fs = new NodeFsAdapter({ root: target })

  // Guard: refuse to clobber a workspace that already exists.
  if (await fs.exists("KNOWLEDGE.md")) {
    return fail(
      `init: refusing to overwrite an existing workspace at ${target}. Delete KNOWLEDGE.md first if you really want to re-init.`,
      1
    )
  }

  let count = 0
  for (const [rel, content] of Object.entries(preset.files)) {
    await fs.writeFile(rel, content)
    count++
  }

  // Optional bootstrap hook for presets that need more than file writes.
  if (preset.bootstrap) {
    await preset.bootstrap({
      workspacePath: "",
      write: (rel, content) => fs.writeFile(rel, content),
    })
  }

  process.stdout.write(
    `corpus: initialized "${preset.slug}" preset (${preset.title}) at ${target}\n` +
      `        ${count} files written\n`
  )
  process.stdout.write(
    `Try: corpus validate ${pathArg ?? "."}\n` +
      `     corpus lint ${pathArg ?? "."}\n`
  )
  return 0
}

async function runList(): Promise<ExitCode> {
  const presets = await discoverPresets()
  if (presets.size === 0) {
    process.stdout.write(
      "corpus init: no presets discovered. Configure corpusPresetPackages[] in ~/.agentproto/config.json or install @agentproto/corpus-presets.\n"
    )
    return 0
  }
  for (const entry of presets.values()) {
    process.stdout.write(`• ${entry.slug}  (${entry.packageName})\n`)
    if (entry.description) {
      process.stdout.write(`    ${entry.description}\n`)
    }
  }
  return 0
}

async function formatAvailable(): Promise<string> {
  const presets = await discoverPresets()
  if (presets.size === 0) {
    return "No presets discovered. Configure corpusPresetPackages[] in ~/.agentproto/config.json or install @agentproto/corpus-presets."
  }
  const slugs = [...presets.keys()].sort()
  return `Available slugs: ${slugs.join(", ")} (run \`corpus init --list\` for details).`
}
