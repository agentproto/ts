/**
 * `corpus init <name> [path]` — scaffold a new AIP-10 corpus.
 *
 * BARE BY DEFAULT: emits a neutral `knowledge.workspace/v1` manifest + the
 * AIP-10 folder structure (kept by `.gitkeep`), nothing else. This is what you
 * want for a fresh research corpus — structure without a domain's boilerplate.
 *
 *   corpus init <name> [path]                      # bare scaffold
 *   corpus init <name> [path] --with operators,playbooks   # + opt-in surfaces
 *   corpus init <name> [path] --preset marketing   # seed a full preset
 *   corpus init --list                             # list available presets
 *
 * Presets are discovered via manifests:
 *   - Default: scans `@agentproto/corpus-presets`.
 *   - Configurable: `corpusPresetPackages[]` in `~/.agentproto/config.json`.
 */

import {
  discoverPresets,
  loadPreset,
} from "../registry/preset-loader.js"
import { NodeFsAdapter } from "../ports/local-fs.adapter.js"
import { buildBareWorkspace, STARTER_SURFACES } from "../scaffold/bare.js"
import { fail, resolveWorkspacePath, type ExitCode } from "./_shared.js"

export async function runInit(args: readonly string[]): Promise<ExitCode> {
  const positionals: string[] = []
  let listOnly = false
  let presetSlug: string | undefined
  const withStarters: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--list" || a === "-l") {
      listOnly = true
    } else if (a === "--preset" || a === "-p") {
      presetSlug = args[++i]
    } else if (a.startsWith("--preset=")) {
      presetSlug = a.slice("--preset=".length)
    } else if (a === "--with" || a === "-w") {
      withStarters.push(...splitList(args[++i]))
    } else if (a.startsWith("--with=")) {
      withStarters.push(...splitList(a.slice("--with=".length)))
    } else {
      positionals.push(a)
    }
  }

  if (listOnly) {
    return runList()
  }

  const [name, pathArg] = positionals
  if (!name) {
    return fail(
      `init requires a <name> argument.\n` +
        `  corpus init <name> [path]                  # bare AIP-10 scaffold (default)\n` +
        `  corpus init <name> [path] --with operators,playbooks\n` +
        `  corpus init <name> [path] --preset <slug>  # seed a full preset\n` +
        `Run \`corpus init --list\` for available presets.`,
      2
    )
  }

  // Validate any requested starter surfaces up front.
  const unknown = withStarters.filter(s => !(s in STARTER_SURFACES))
  if (unknown.length) {
    return fail(
      `init: unknown --with surface(s): ${unknown.join(", ")}. ` +
        `Known: ${Object.keys(STARTER_SURFACES).join(", ")}.`,
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

  // ── Preset path (opt-in) ──
  if (presetSlug) {
    const preset = await loadPreset(presetSlug)
    if (!preset) {
      const available = await formatAvailable()
      return fail(
        `init: preset "${presetSlug}" not found in any configured package.\n${available}`,
        2
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
        `        ${count} files written\n` +
        `Try: corpus validate ${pathArg ?? "."}\n` +
        `     corpus lint ${pathArg ?? "."}\n`
    )
    return 0
  }

  // ── Bare path (default) ──
  const files = buildBareWorkspace(name, withStarters)
  let count = 0
  for (const [rel, content] of Object.entries(files)) {
    await fs.writeFile(rel, content)
    count++
  }
  const withNote = withStarters.length
    ? ` (+ starters: ${withStarters.join(", ")})`
    : ""
  process.stdout.write(
    `corpus: initialized bare corpus "${name}"${withNote} at ${target}\n` +
      `        ${count} files written — neutral KNOWLEDGE.md + AIP-10 structure\n` +
      `Try: corpus import-web ${pathArg ?? "."} --urls-file urls.txt\n` +
      `     corpus validate ${pathArg ?? "."}\n`
  )
  return 0
}

function splitList(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
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
