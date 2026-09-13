import assert from "node:assert/strict"
import { test } from "node:test"
import {
  DEFAULTS,
  KNOWN_CODEGEN_MISSING,
  checkSpecDrift,
  normalizeSchemaSrc,
  specDirCandidates,
  stageTempTree,
} from "./check-spec-drift.mjs"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "..")

test("normalizeSchemaSrc strips exactly the known-drift fields", () => {
  // The real list is currently empty (every declared field is codegen-derivable),
  // so exercise the stripper with a synthetic field injected via `fields`.
  const src = 'z.object({ "__synthetic__": z.any().describe("x").optional(), "b": z.number() })'
  const stripped = normalizeSchemaSrc(src, DEFAULTS.slug, ["__synthetic__"])
  assert.ok(!stripped.includes('"__synthetic__"'))
  assert.ok(stripped.includes('"b"'))
  assert.deepEqual(KNOWN_CODEGEN_MISSING, [])
  assert.equal(normalizeSchemaSrc(src), src)
})

test("normalizeSchemaSrc leaves other fields untouched", () => {
  const src = 'z.object({ "identity": z.any().describe("AIP-23 identity-ref").optional() })'
  assert.equal(normalizeSchemaSrc(src), src)
})

test("specDirCandidates covers vendored + sibling layouts", () => {
  const [vendored, sibling] = specDirCandidates(ROOT)
  assert.equal(vendored, resolve(ROOT, "specs"))
  assert.ok(existsSync(vendored))
  assert.ok(sibling.endsWith(join("agentproto", "specs")))
})

test("stageTempTree stages a runnable scaffolder tree", (t) => {
  const staged = stageTempTree(ROOT, DEFAULTS)
  t.after(() => rmSync(staged.tmp, { recursive: true, force: true }))
  assert.ok(existsSync(staged.scaffoldPath))
  assert.ok(existsSync(staged.specJsonPath))
  assert.ok(readFileSync(staged.specJsonPath, "utf8").includes("autoPassthrough"))
})

test("checkSpecDrift passes on the in-sync vendored JSON draft", async () => {
  const result = await checkSpecDrift()
  assert.equal(result.ok, true, result.message)
})
