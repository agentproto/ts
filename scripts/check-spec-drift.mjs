#!/usr/bin/env node
/**
 * check-spec-drift — fail CI when the GENERATED schema.ts of a scaffolded
 * package has drifted from its JSON-Schema draft.
 *
 * Incident class (PR #1235): `packages/sandbox/src/{schema,types}.ts` were
 * hand-edited without updating
 * `specs/resources/aip-36/draft/SANDBOX.schema.json`. The next regen of
 * `scaffold-aip` would have silently erased the hand-added field. Nothing
 * detected that — this script does.
 *
 * How it works: re-runs `scripts/scaffold-aip.mjs --schema-only` against
 * the vendored JSON draft — the scaffolder reads `specs/resources`
 * directly since #1207, so no temp tree is staged — then diffs the
 * emitted schema.ts against the checked-in
 * `packages/<slug>/src/schema.ts`. Exit 1 on any divergence.
 *
 * `types.ts` is NOT diffed: its own header says the handle/runtime types
 * are hand-tuned on top of the generated base, so a mechanical diff is
 * meaningless there. `schema.ts` is the single validation source of truth
 * (both the TS and .md authoring paths validate through it), which makes
 * it the load-bearing generated artifact.
 *
 * Usage: node scripts/check-spec-drift.mjs
 *   --aip 36 --slug sandbox --doctype SANDBOX  (these defaults)
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..")

export const DEFAULTS = { aip: 36, slug: "sandbox", doctype: "SANDBOX" }

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1]
  }
  return args
}

export async function checkSpecDrift(opts = {}) {
  const { aip, slug, doctype } = { ...DEFAULTS, ...opts }
  const specJsonPath = resolve(ROOT, "specs", "resources", `aip-${aip}`, "draft", `${doctype}.schema.json`)
  if (!existsSync(specJsonPath)) {
    return { ok: false, message: `JSON draft not found: ${specJsonPath}` }
  }

  const res = spawnSync(
    process.execPath,
    [
      resolve(ROOT, "scripts", "scaffold-aip.mjs"),
      "--aip", String(aip),
      "--slug", slug,
      "--doctype", doctype,
      "--schema-only",
    ],
    { encoding: "utf8", cwd: ROOT },
  )
  if (res.status !== 0) {
    return { ok: false, message: `scaffold-aip --schema-only failed:\n${res.stderr || res.stdout}` }
  }

  const checkedIn = readFileSync(resolve(ROOT, "packages", slug, "src", "schema.ts"), "utf8")
  if (res.stdout === checkedIn) {
    return { ok: true, message: `spec↔codegen in sync for @agentproto/${slug}` }
  }
  const lines = []
  const e = res.stdout.split("\n")
  const a = checkedIn.split("\n")
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    if (e[i] !== a[i]) {
      lines.push(`line ${i + 1}:`)
      lines.push(`  expected (regen): ${(e[i] ?? "").slice(0, 200)}`)
      lines.push(`  actual  (repo):   ${(a[i] ?? "").slice(0, 200)}`)
    }
  }
  return {
    ok: false,
    message:
      `spec/codegen DRIFT in packages/${slug}/src/schema.ts — regenerate with ` +
      `\`node scripts/scaffold-aip.mjs --aip ${aip} --slug ${slug} --doctype ${doctype} --schema-only\` ` +
      `(or update the JSON draft first, then regen):\n${lines.join("\n")}`,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  const result = await checkSpecDrift({
    aip: Number(args.aip ?? DEFAULTS.aip),
    slug: args.slug ?? DEFAULTS.slug,
    doctype: (args.doctype ?? DEFAULTS.doctype).toUpperCase(),
  })
  console[result.ok ? "log" : "error"](result.message)
  process.exit(result.ok ? 0 : 1)
}