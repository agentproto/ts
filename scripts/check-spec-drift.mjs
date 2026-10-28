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
 * The leading doc comment of schema.ts is NOT compared (`schemaCode`): the
 * scaffolder emits a template header, and a package may rewrite it to
 * describe its own files. Only the code below it is load-bearing.
 *
 * `types.ts` is NOT diffed: its own header says the handle/runtime types
 * are hand-tuned on top of the generated base, so a mechanical diff is
 * meaningless there. `schema.ts` is the single validation source of truth
 * (both the TS and .md authoring paths validate through it), which makes
 * it the load-bearing generated artifact.
 *
 * Usage: node scripts/check-spec-drift.mjs
 *   --aip 36 --slug sandbox --doctype SANDBOX  (these defaults)
 *   [--inline-refs]
 *
 * A manual run of a package DEFAULT_PACKAGES guards takes that entry's
 * flags (`--inline-refs` for AIP-72), so it regens exactly as the scripted
 * run does; `--inline-refs` sets the flag for any other package.
 *
 * With no arguments the CLI checks EVERY entry of DEFAULT_PACKAGES (not
 * just sandbox) — one regen per guarded package, all failures reported,
 * exit 1 if any drifts. CI invokes the no-arg form, so adding a package
 * to DEFAULT_PACKAGES widens the CI guard without a workflow change.
 * `checkSpecDrift(opts)` (the API) keeps DEFAULTS as its single-package
 * default.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..")

export const DEFAULTS = { aip: 36, slug: "sandbox", doctype: "SANDBOX" }

/** Packages the no-arg CLI run guards. AIP-20/work joined after the
 *  redesigned WORK draft shipped in the AIP-49/AIP-20/… re-vendor
 *  (#2043), which left `packages/work/src/schema.ts` stale — the
 *  single-package default would not have caught it. */
export const DEFAULT_PACKAGES = [
  DEFAULTS,
  { aip: 20, slug: "work", doctype: "WORK" },
  // AIP-72's lifetime/provenance/evidence are `$ref`s; without
  // `--inline-refs` they would generate as `z.any()`.
  { aip: 72, slug: "memory", doctype: "MEMORY", inlineRefs: true },
]

const BOOLEAN_FLAGS = new Set(["inline-refs"])

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue
    const key = argv[i].slice(2)
    if (BOOLEAN_FLAGS.has(key)) args[key] = true
    else args[key] = argv[++i]
  }
  return args
}

/** The packages a CLI run checks: every DEFAULT_PACKAGES entry with no
 *  arguments, otherwise the one named, with the flags of its guarded entry
 *  when it has one. */
export function cliTargets(argv) {
  const args = parseArgs(argv)
  const explicit =
    args.aip !== undefined || args.slug !== undefined || args.doctype !== undefined
  if (!explicit) return DEFAULT_PACKAGES
  const named = {
    aip: Number(args.aip ?? DEFAULTS.aip),
    slug: args.slug ?? DEFAULTS.slug,
    doctype: (args.doctype ?? DEFAULTS.doctype).toUpperCase(),
  }
  const guarded = DEFAULT_PACKAGES.find(
    p => p.aip === named.aip && p.slug === named.slug && p.doctype === named.doctype,
  )
  const inlineRefs = args["inline-refs"] === true || guarded?.inlineRefs === true
  return [{ ...named, ...(inlineRefs ? { inlineRefs: true } : {}) }]
}

/** schema.ts without its leading `/** ... *\/` doc comment (and the blank
 *  lines after it), so a package-specific header is not reported as drift. */
export function schemaCode(src) {
  return src.replace(/^\/\*\*[\s\S]*?\*\/\n*/, "")
}

export async function checkSpecDrift(opts = {}) {
  const { aip, slug, doctype, inlineRefs } = { ...DEFAULTS, ...opts }
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
      ...(inlineRefs ? ["--inline-refs"] : []),
    ],
    { encoding: "utf8", cwd: ROOT },
  )
  if (res.status !== 0) {
    return { ok: false, message: `scaffold-aip --schema-only failed:\n${res.stderr || res.stdout}` }
  }

  const checkedIn = schemaCode(
    readFileSync(resolve(ROOT, "packages", slug, "src", "schema.ts"), "utf8"),
  )
  const regen = schemaCode(res.stdout)
  if (regen === checkedIn) {
    return { ok: true, message: `spec↔codegen in sync for @agentproto/${slug}` }
  }
  const lines = []
  const e = regen.split("\n")
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
      `\`node scripts/scaffold-aip.mjs --aip ${aip} --slug ${slug} --doctype ${doctype} --schema-only${inlineRefs ? " --inline-refs" : ""}\` ` +
      `(or update the JSON draft first, then regen):\n${lines.join("\n")}`,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targets = cliTargets(process.argv.slice(2))
  let ok = true
  for (const t of targets) {
    const result = await checkSpecDrift(t)
    if (result.ok) {
      console.log(result.message)
    } else {
      ok = false
      console.error(
        targets.length > 1 ? `@agentproto/${t.slug}: ${result.message}` : result.message,
      )
    }
  }
  process.exit(ok ? 0 : 1)
}