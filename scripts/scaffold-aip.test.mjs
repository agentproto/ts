import assert from "node:assert/strict"
import { test } from "node:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const REPO_ROOT = resolve(HERE, "..")

const FIXTURE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Test Doc",
  description: "Test doctype for scaffolder tests",
  type: "object",
  required: ["id", "description"],
  properties: {
    id: { type: "string" },
    description: { type: "string" },
  },
}

// Build a fixture tree that is NOT a git repo and has NO sibling
// `agentproto` spec checkout: <tmp>/scripts/scaffold-aip.mjs +
// <tmp>/specs/resources/aip-99/draft/TEST.schema.json. node_modules is
// symlinked from the real repo so the scaffolder's imports resolve.
// Returns { tmp, scaffold, run } where run(argv, opts) spawns the
// fixture scaffolder with cwd=<tmp> (override with opts.cwd).
function makeFixture(t) {
  const tmp = mkdtempSync(join(tmpdir(), "scaffold-aip-test-"))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  mkdirSync(join(tmp, "scripts"), { recursive: true })
  cpSync(join(REPO_ROOT, "scripts", "scaffold-aip.mjs"), join(tmp, "scripts", "scaffold-aip.mjs"))
  symlinkSync(join(REPO_ROOT, "node_modules"), join(tmp, "node_modules"))
  const draftDir = join(tmp, "specs", "resources", "aip-99", "draft")
  mkdirSync(draftDir, { recursive: true })
  writeFileSync(join(draftDir, "TEST.schema.json"), JSON.stringify(FIXTURE_SCHEMA, null, 2))
  const scaffold = join(tmp, "scripts", "scaffold-aip.mjs")
  const run = (argv, opts = {}) =>
    spawnSync(process.execPath, [scaffold, ...argv], {
      encoding: "utf8",
      cwd: opts.cwd ?? tmp,
    })
  return { tmp, scaffold, run }
}

test("--schema-only emits the schema.ts content from the vendored draft", (t) => {
  const { run } = makeFixture(t)
  const res = run(["--schema-only", "--aip", "99", "--slug", "test", "--doctype", "TEST"])
  assert.equal(res.status, 0, res.stderr)
  assert.ok(res.stdout.includes("export const testFrontmatterSchema"), res.stdout)
  assert.ok(res.stdout.includes('"id": z.string()'), res.stdout)
  assert.ok(res.stdout.includes('"description": z.string()'), res.stdout)
  // Title/description come from the JSON draft now (gray-matter/mdx is
  // gone): the root schema description is rendered by json-schema-to-zod.
  assert.ok(res.stdout.includes("Test doctype for scaffolder tests"), res.stdout)
})

test("full scaffold prints the draft title, never a sibling mdx title", (t) => {
  const { tmp, run } = makeFixture(t)
  // Isolation proof (#1207): a sibling checkout's spec for aip-99 with a
  // poisoned title exists where the OLD scaffolder would have read it
  // (<tmp>/../agentproto/specs). The vendored-tree scaffolder must never
  // touch it.
  const siblingSpecs = join(tmp, "..", "agentproto", "specs")
  mkdirSync(siblingSpecs, { recursive: true })
  writeFileSync(join(siblingSpecs, "aip-99.mdx"), '---\ntitle: "WRONG SIBLING"\n---\n')
  t.after(() => rmSync(join(tmp, "..", "agentproto"), { recursive: true, force: true }))

  const res = run(["--aip", "99", "--slug", "test", "--doctype", "TEST"])
  assert.equal(res.status, 0, res.stderr)
  assert.ok(res.stdout.includes("Test Doc"), res.stdout)
  assert.ok(!res.stdout.includes("WRONG SIBLING"), res.stdout)
  assert.ok(existsSync(join(tmp, "packages", "test", "src", "schema.ts")))
})

test("--resources-dir pointing at a nonexistent dir exits 2", (t) => {
  const { run } = makeFixture(t)
  const res = run(["--schema-only", "--aip", "99", "--slug", "test", "--doctype", "TEST", "--resources-dir", "/nonexistent/f1207/xyz"])
  assert.equal(res.status, 2)
  assert.match(res.stderr, /not found/)
})

test("--resources-dir override pointing at the vendored tree works", (t) => {
  const { tmp, run } = makeFixture(t)
  const res = run([
    "--schema-only", "--aip", "99", "--slug", "test", "--doctype", "TEST",
    "--resources-dir", join(tmp, "specs", "resources"),
  ])
  assert.equal(res.status, 0, res.stderr)
  assert.ok(res.stdout.includes("export const testFrontmatterSchema"), res.stdout)
})

test("unknown flag exits 2", (t) => {
  const { run } = makeFixture(t)
  const res = run(["--bogus", "x", "--aip", "99", "--slug", "test", "--doctype", "TEST"])
  assert.equal(res.status, 2)
  assert.match(res.stderr, /unknown flag --bogus/)
})

test("flag with no value exits 2", (t) => {
  const { run } = makeFixture(t)
  const res = run(["--schema-only", "--slug", "test", "--doctype", "TEST", "--aip"])
  assert.equal(res.status, 2)
  assert.match(res.stderr, /requires a value/)
})

test("missing required flags exits 2 with usage", (t) => {
  const { run } = makeFixture(t)
  const res = run(["--aip", "99"])
  assert.equal(res.status, 2)
  assert.match(res.stderr, /Usage: scaffold-aip/)
})

test("broken external ref fails closed (no warn-and-stub)", (t) => {
  const { tmp, run } = makeFixture(t)
  const draftDir = join(tmp, "specs", "resources", "aip-99", "draft")
  writeFileSync(
    join(draftDir, "BROKEN.schema.json"),
    JSON.stringify({
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        ref: { $ref: "https://agentproto.dev/schemas/aip-999/NOPE.schema.json" },
      },
    }),
  )
  const res = run(["--schema-only", "--aip", "99", "--slug", "test", "--doctype", "BROKEN"])
  assert.notEqual(res.status, 0)
  assert.match(res.stderr, /aip-999|NOPE/)
  assert.ok(!res.stderr.includes("replacing with empty schema"), res.stderr)
})