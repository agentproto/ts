import assert from "node:assert/strict"
import { test } from "node:test"
import {
  DEFAULTS,
  KNOWN_CODEGEN_MISSING,
  checkSpecDrift,
  normalizeSchemaSrc,
  stageTempTree,
} from "./check-spec-drift.mjs"
import { existsSync, readFileSync, rmSync, mkdtempSync, mkdirSync, cpSync, symlinkSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
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

test("stageTempTree stages a runnable scaffolder tree", (t) => {
  const staged = stageTempTree(ROOT, DEFAULTS)
  t.after(() => rmSync(staged.tmp, { recursive: true, force: true }))
  assert.ok(existsSync(staged.scaffoldPath))
  assert.ok(existsSync(staged.specJsonPath))
  assert.equal(staged.specJsonPath, join(staged.tmp, "repo", "specs", "resources", "aip-36", "draft", "SANDBOX.schema.json"))
  assert.equal(existsSync(join(staged.tmp, "agentproto")), false)
  assert.ok(readFileSync(staged.specJsonPath, "utf8").includes("autoPassthrough"))
})

test("checkSpecDrift passes on the in-sync vendored JSON draft", async () => {
  const result = await checkSpecDrift()
  assert.equal(result.ok, true, result.message)
})

test("schema-only generation uses the vendored draft in an isolated checkout", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "scaffold-vendored-"))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const repo = join(tmp, "repo")
  mkdirSync(join(repo, "scripts"), { recursive: true })
  mkdirSync(join(repo, "specs"), { recursive: true })
  cpSync(join(ROOT, "scripts", "scaffold-aip.mjs"), join(repo, "scripts", "scaffold-aip.mjs"))
  symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"))
  symlinkSync(join(ROOT, "specs", "resources"), join(repo, "specs", "resources"))

  const spec = JSON.parse(readFileSync(join(ROOT, "specs", "resources", "aip-15", "draft", "WORKFLOW.schema.json"), "utf8"))
  assert.ok(JSON.stringify(spec).includes('"agent"'))
  assert.ok(JSON.stringify(spec).includes('"gate"'))

  const result = spawnSync(process.execPath, [join(repo, "scripts", "scaffold-aip.mjs"),
    "--aip", "15", "--slug", "workflow", "--doctype", "WORKFLOW", "--schema-only"],
    { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes("workflowFrontmatterSchema"))
  assert.ok(result.stdout.includes("AIP-41 ROUTINE.md routines"))
  assert.equal(existsSync(join(tmp, "agentproto")), false)
})
