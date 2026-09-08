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
 * the vendored JSON draft in an isolated temp tree (the scaffolder
 * hardcodes `SPEC_DIR = <repo>/../agentproto/specs`, which does not exist
 * in checkouts/CI, so we stage `<tmp>/agentproto/specs` + a copy of the
 * scaffolder and run it from there), then diffs the emitted schema.ts
 * against the checked-in `packages/<slug>/src/schema.ts`. Exit 1 on any
 * divergence.
 *
 * `types.ts` is NOT diffed: its own header says the handle/runtime types
 * are hand-tuned on top of the generated base, so a mechanical diff is
 * meaningless there. `schema.ts` is the single validation source of truth
 * (both the TS and .md authoring paths validate through it), which makes
 * it the load-bearing generated artifact.
 *
 * No known drift is currently suppressed: `KNOWN_CODEGEN_MISSING` is kept
 * as an empty escape hatch in case a future draft/codegen gap needs the
 * same warn-and-strip treatment while it is fixed separately.
 *
 * Usage: node scripts/check-spec-drift.mjs
 *   --aip 36 --slug sandbox --doctype SANDBOX  (these defaults)
 */

import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..")

export const DEFAULTS = { aip: 36, slug: "sandbox", doctype: "SANDBOX" }

// Top-level schema properties present in the JSON draft but (known)
// missing from the checked-in generated schema.ts. Empty today — the
// historical `policy` drift was closed by a real regen; this remains as
// an escape hatch for any future known gap (see file header).
export const KNOWN_CODEGEN_MISSING = []

/**
 * Strip the known-drift top-level properties from a generated schema.ts
 * body so tracked (warned-elsewhere) drift doesn't mask new drift.
 */
export function normalizeSchemaSrc(src, slug = DEFAULTS.slug) {
  let out = src
  for (const field of KNOWN_CODEGEN_MISSING) {
    out = out.replace(
      new RegExp(
        `"${field}":\\s*z\\.any\\(\\)\\.describe\\("[^"]*"\\)\\.optional\\(\\),\\s*`,
        "g",
      ),
      "",
    )
  }
  return out
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1]
  }
  return args
}

export function specDirCandidates(root) {
  return [
    resolve(root, "specs"), // vendored layout (this repo, CI)
    resolve(root, "..", "agentproto", "specs"), // sibling spec-repo layout
  ]
}

/**
 * Stage the temp tree the scaffolder needs:
 *   <tmp>/repo/scripts/scaffold-aip.mjs   — copy (TS_ROOT must be <tmp>/repo)
 *   <tmp>/repo/node_modules               — symlink to the real one
 *   <tmp>/agentproto/specs/resources      — symlink to the real drafts
 *   <tmp>/agentproto/specs/aip-<N>.mdx    — real spec if found, else a stub
 *                                             (only its frontmatter is read)
 * Returns { tmp, scaffoldPath, specJsonPath }.
 */
export function stageTempTree(root, { aip, slug, doctype }) {
  const tmp = mkdtempSync(join(tmpdir(), "spec-drift-"))
  const repo = join(tmp, "repo")
  const specs = join(tmp, "agentproto", "specs")
  mkdirSync(join(repo, "scripts"), { recursive: true })
  mkdirSync(specs, { recursive: true })

  cpSync(join(root, "scripts", "scaffold-aip.mjs"), join(repo, "scripts", "scaffold-aip.mjs"))
  symlinkSync(join(root, "node_modules"), join(repo, "node_modules"))
  symlinkSync(join(root, "specs", "resources"), join(specs, "resources"))

  const mdx = `aip-${aip}.mdx`
  const realSpec = specDirCandidates(root)
    .map((dir) => join(dir, mdx))
    .find(existsSync)
  if (realSpec) {
    cpSync(realSpec, join(specs, mdx))
  } else {
    writeFileSync(
      join(specs, mdx),
      `---\ntitle: "AIP-${aip}: ${doctype}.md"\ndescription: "drift-check stub"\n---\n\nStub for check-spec-drift — the scaffolder only reads frontmatter.\n`,
    )
  }

  return {
    tmp,
    scaffoldPath: join(repo, "scripts", "scaffold-aip.mjs"),
    specJsonPath: join(specs, "resources", `aip-${aip}`, "draft", `${doctype}.schema.json`),
    generatedPath: join(repo, "packages", slug, "src", "schema.ts"),
  }
}

export async function checkSpecDrift(opts = {}) {
  const { aip, slug, doctype } = { ...DEFAULTS, ...opts }
  const specJsonPath = resolve(ROOT, "specs", "resources", `aip-${aip}`, "draft", `${doctype}.schema.json`)
  if (!existsSync(specJsonPath)) {
    return { ok: false, message: `JSON draft not found: ${specJsonPath}` }
  }

  const { tmp, scaffoldPath, generatedPath } = stageTempTree(ROOT, { aip, slug, doctype })
  try {
    const res = spawnSync(
      process.execPath,
      [scaffoldPath, "--aip", String(aip), "--slug", slug, "--doctype", doctype, "--schema-only"],
      { encoding: "utf8" },
    )
    if (res.status !== 0) {
      return { ok: false, message: `scaffold-aip --schema-only failed:\n${res.stderr || res.stdout}` }
    }

    const checkedIn = readFileSync(resolve(ROOT, "packages", slug, "src", "schema.ts"), "utf8")
    const expected = normalizeSchemaSrc(res.stdout, slug)
    const actual = normalizeSchemaSrc(checkedIn, slug)
    if (expected === actual) {
      return { ok: true, message: `spec↔codegen in sync for @agentproto/${slug}` }
    }
    const lines = []
    const e = expected.split("\n")
    const a = actual.split("\n")
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
  } finally {
    rmSync(tmp, { recursive: true, force: true })
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
