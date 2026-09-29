#!/usr/bin/env node
/**
 * Runs every native-vendor sync script in this directory.
 *
 * WHY THIS EXISTS. There are two catalog sync mechanisms in this repo and only
 * one of them was automated:
 *
 *   1. `@agentproto/catalog-sync generate` (packages/catalog-sync/src/generators/)
 *      — snapshot-backed, deterministic, run weekly by
 *      `.github/workflows/catalog-sync.yml`.
 *   2. The `sync-*.mjs` scripts here — live vendor/passthrough fetches that
 *      write the per-vendor `*-pricing.generated.ts` files. Nothing ran these.
 *      They were hand-invoked, so the native vendor lists silently went stale
 *      between whenever a human last remembered: `openai-pricing.generated.ts`
 *      sat at its 2026-08-31 sync and topped out at `gpt-5.6-*` while
 *      OpenRouter had been carrying the whole `gpt-6-{luna,sol,astra}` family
 *      for weeks — data the repo's own committed OpenRouter snapshot already
 *      contained.
 *
 * So this is the (2) entrypoint the weekly workflow calls, alongside the (1)
 * one it already called. Scripts are DISCOVERED by glob, not listed: adding
 * `sync-<vendor>.mjs` wires it into the weekly run with no edit here, which is
 * the whole point — a list is one more thing to forget to update.
 *
 * EXIT-CODE CONTRACT (the reason this isn't a shell one-liner):
 *   0 — synced.
 *   2 — skipped on purpose. `sync-mistral.mjs` / `sync-xai.mjs` exit 2 when
 *       their API key is absent, mirroring how `catalog-sync generate` reuses a
 *       committed snapshot when a secret is missing. A missing optional secret
 *       must NOT redden the weekly job.
 *   anything else — a real failure (vendor API broke, output shape changed).
 *
 * We exit non-zero only for that third case, and only after running every
 * script: one dead vendor API shouldn't cost the diff from the other six.
 *
 * CATALOG-CHANGELOG. `catalog-sync generate` logs its own id adds/removes to
 * packages/model-catalog/CATALOG-CHANGELOG.md, but these native lists never
 * did — claude-sonnet-5-5 showed up under llm:openrouter and
 * llm:context-windows while its native llm:anthropic entry went unlogged.
 * So we diff each `sync-<vendor>.mjs` output's top-level ids before/after
 * (same key shape and format as packages/catalog-sync/src/changelog.ts) and
 * append `### llm:<vendor>` subsections — into today's section when the
 * generate step already opened one, else under a new `## <date>` header.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const DIR = import.meta.dirname
const SKIP_EXIT_CODE = 2
const LLM_DIR = resolve(DIR, "../../packages/model-catalog/src/llm")
const CHANGELOG_PATH = resolve(DIR, "../../packages/model-catalog/CATALOG-CHANGELOG.md")
const RECORD_KEY_RE = /^ {2}"([^"]+)":\s*\{/gm

const vendorOf = script => script.slice("sync-".length, -".mjs".length)
const outputOf = script => resolve(LLM_DIR, `${vendorOf(script)}-pricing.generated.ts`)

function readIds(path) {
  if (!existsSync(path)) return new Set()
  return new Set([...readFileSync(path, "utf-8").matchAll(RECORD_KEY_RE)].map(m => m[1]))
}

function appendChangelog(entries) {
  const nonEmpty = entries.filter(e => e.added.length > 0 || e.removed.length > 0)
  if (nonEmpty.length === 0 || !existsSync(CHANGELOG_PATH)) return
  const date = new Date().toISOString().slice(0, 10)
  const existing = readFileSync(CHANGELOG_PATH, "utf-8").replace(/\n+$/, "\n")
  const lastHeader = [...existing.matchAll(/^## (\S+)$/gm)].at(-1)?.[1]
  const lines = lastHeader === date ? [] : [`## ${date}`, ""]
  for (const e of nonEmpty) {
    lines.push(`### llm:${e.vendor}`)
    if (e.added.length > 0) lines.push(`- Added: ${e.added.join(", ")}`)
    if (e.removed.length > 0) lines.push(`- Removed: ${e.removed.join(", ")}`)
    lines.push("")
  }
  writeFileSync(CHANGELOG_PATH, `${existing}\n${lines.join("\n").replace(/\n+$/, "\n")}`, "utf-8")
  console.log(`  changelog: ${nonEmpty.map(e => `llm:${e.vendor}`).join(", ")}`)
}

const scripts = readdirSync(DIR)
  .filter(name => name.startsWith("sync-") && name.endsWith(".mjs"))
  .sort()

if (scripts.length === 0) {
  console.error(`No sync-*.mjs scripts found in ${DIR}`)
  process.exit(1)
}

console.log(`Running ${scripts.length} native-vendor sync script(s)…\n`)

const synced = []
const skipped = []
const failed = []
const idDiffs = []

for (const script of scripts) {
  console.log(`━━━ ${script} ━━━`)
  const before = readIds(outputOf(script))
  const result = spawnSync(process.execPath, [`${DIR}/${script}`], {
    stdio: "inherit",
    env: process.env,
  })

  // A signal kill reports `status: null` — treat it as a failure, never as a
  // pass, or a SIGKILLed script would read as "synced".
  const code = result.status ?? 1

  if (result.error) {
    failed.push({ script, reason: result.error.message })
  } else if (code === 0) {
    synced.push(script)
  } else if (code === SKIP_EXIT_CODE) {
    skipped.push(script)
  } else {
    failed.push({ script, reason: `exit ${code}` })
  }
  const after = readIds(outputOf(script))
  idDiffs.push({
    vendor: vendorOf(script),
    added: [...after].filter(id => !before.has(id)).sort(),
    removed: [...before].filter(id => !after.has(id)).sort(),
  })
  console.log("")
}

appendChangelog(idDiffs)

console.log("━━━ summary ━━━")
console.log(`  synced:  ${synced.length}${synced.length ? ` (${synced.join(", ")})` : ""}`)
console.log(`  skipped: ${skipped.length}${skipped.length ? ` (${skipped.join(", ")})` : ""}`)
console.log(`  failed:  ${failed.length}`)
for (const { script, reason } of failed) {
  console.error(`    ✗ ${script}: ${reason}`)
}

if (failed.length > 0) {
  console.error(
    `\n${failed.length} native-vendor sync script(s) failed. Skips (exit ${SKIP_EXIT_CODE}, ` +
      `missing optional API key) are not counted here.`
  )
  process.exit(1)
}

console.log("\n✓ All native-vendor sync scripts completed (skips are expected without keys).")
