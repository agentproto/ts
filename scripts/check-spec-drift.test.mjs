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

test("normalizeSchemaSrc strips known-drift fields", () => {
  const withPolicy =
    'export const x = z.object({ "a": z.string(), "policy": z.any().describe("AIP-38 POLICY block — access grants on sandbox actions.").optional(), "b": z.number() })'
  const out = normalizeSchemaSrc(withPolicy)
  assert.ok(!out.includes('"policy"'))
  assert.ok(out.includes('"a"') && out.includes('"b"'))
  for (const field of KNOWN_CODEGEN_MISSING) {
    assert.equal(normalizeSchemaSrc(`z.object({ "${field}": z.any().describe("x").optional(), })`).includes(`"${field}"`), false)
  }
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
