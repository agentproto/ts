#!/usr/bin/env node

/**
 * catalog-sync CLI.
 *
 *   catalog-sync generate [--refresh] [--check]
 *
 * - `generate` (default)  — generate from pinned snapshots, write changed files.
 * - `--refresh`           — re-fetch each source's pinned URL into snapshots/.
 * - `--check`             — generate in memory, diff vs committed files; exit 1
 *                           on drift. This is what CI runs. Never writes.
 */

import { llmOpenRouterGenerator } from "./generators/llm-openrouter.js"
import { voiceElevenlabs } from "./generators/voice-elevenlabs.js"
import { voiceMinimax } from "./generators/voice-minimax.js"
import { imageReplicate } from "./generators/image-replicate.js"
import { runGenerators } from "./runner.js"

const args = process.argv.slice(2)
const command = args[0] ?? ""
const flags = new Set(args.slice(1))

const KNOWN_FLAGS = new Set(["--refresh", "--check"])
const unknownFlags = [...flags].filter((f) => !KNOWN_FLAGS.has(f))

if (command !== "generate" || unknownFlags.length > 0) {
  if (command !== "generate") {
    process.stderr.write(
      `catalog-sync: unknown command "${command}". Usage: catalog-sync generate [--refresh] [--check]\n`
    )
  }
  if (unknownFlags.length > 0) {
    process.stderr.write(`catalog-sync: unknown flag(s) ${unknownFlags.join(", ")}\n`)
  }
  process.exit(2)
}

const refresh = flags.has("--refresh")
const check = flags.has("--check")
const generators = [
  llmOpenRouterGenerator,
  voiceElevenlabs,
  voiceMinimax,
  imageReplicate,
]

const { changed, files } = await runGenerators(generators, {
  refresh,
  write: !check,
})

if (check) {
  if (changed.length > 0) {
    process.stderr.write(
      `catalog-sync: drift detected — ${changed.length} file(s) differ from committed:\n`
    )
    for (const p of changed) process.stderr.write(`  ${p}\n`)
    process.stderr.write(`Re-run \`catalog-sync generate\` to update.\n`)
    process.exit(1)
  }
  process.stdout.write(
    `catalog-sync: no drift (${generators.length} generator(s), ${Object.keys(files).length} file(s) up to date).\n`
  )
  process.exit(0)
}

if (changed.length > 0) {
  process.stdout.write(`catalog-sync: wrote ${changed.length} file(s):\n`)
  for (const p of changed) process.stdout.write(`  ${p}\n`)
} else {
  process.stdout.write(`catalog-sync: no changes.\n`)
}
process.exit(0)
