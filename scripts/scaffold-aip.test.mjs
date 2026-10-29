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

// ── oneOf branches that are `$ref`s ──────────────────────────────────
// json-schema-to-zod renders a `$ref` as `z.any()`. As a `oneOf` branch that
// matches every value, so the library's "exactly one branch passes" check
// counted an array twice and rejected it (AGENT.md `on:` arrays, AIP-42).
// The scaffolder resolves the refs of a `oneOf` branch before it decides
// whether the branches are disjoint.
function writeDraft(tmp, name, schema) {
  writeFileSync(
    join(tmp, "specs", "resources", "aip-99", "draft", `${name}.schema.json`),
    JSON.stringify({ type: "object", required: ["id"], ...schema }),
  )
}

test("a oneOf of $ref and array-of-$ref renders a union over the resolved ref", (t) => {
  const { tmp, run } = makeFixture(t)
  writeDraft(tmp, "HOOKS", {
    properties: {
      id: { type: "string" },
      on: {
        type: "object",
        additionalProperties: {
          oneOf: [
            { $ref: "#/$defs/actionRef" },
            { type: "array", items: { $ref: "#/$defs/actionRef" } },
          ],
        },
      },
    },
    $defs: {
      actionRef: {
        oneOf: [
          { type: "string", minLength: 1 },
          { type: "object", properties: { action: { type: "string" } } },
        ],
      },
    },
  })
  const res = run(["--schema-only", "--aip", "99", "--slug", "test", "--doctype", "HOOKS"])
  assert.equal(res.status, 0, res.stderr)
  assert.ok(!res.stdout.includes("superRefine"), res.stdout)
  assert.match(res.stdout, /z\.union\(\[z\.union\(\[z\.string\(\)\.min\(1\), z\.object\(/, res.stdout)
  assert.match(res.stdout, /z\.array\(z\.union\(\[z\.string\(\)\.min\(1\), z\.object\(/, res.stdout)
})

test("a oneOf of $ref objects sharing a const discriminator renders a discriminatedUnion", (t) => {
  const { tmp, run } = makeFixture(t)
  writeDraft(tmp, "CHECKS", {
    properties: {
      id: { type: "string" },
      checks: {
        type: "array",
        items: { oneOf: [{ $ref: "#/$defs/cmd" }, { $ref: "#/$defs/agent" }] },
      },
    },
    $defs: {
      cmd: { type: "object", properties: { kind: { const: "command" }, run: { type: "string" } } },
      agent: { type: "object", properties: { kind: { const: "agent" }, preset: { type: "string" } } },
    },
  })
  const res = run(["--schema-only", "--aip", "99", "--slug", "test", "--doctype", "CHECKS"])
  assert.equal(res.status, 0, res.stderr)
  assert.ok(!res.stdout.includes("superRefine"), res.stdout)
  assert.match(res.stdout, /z\.discriminatedUnion\("kind", \[z\.object\(/, res.stdout)
})

test("a oneOf whose $ref branches overlap keeps the exactly-one check", (t) => {
  const { tmp, run } = makeFixture(t)
  writeDraft(tmp, "OVERLAP", {
    properties: {
      id: { type: "string" },
      name: { oneOf: [{ $ref: "#/$defs/short" }, { $ref: "#/$defs/long" }] },
    },
    $defs: {
      short: { type: "string", maxLength: 3 },
      long: { type: "string", minLength: 3 },
    },
  })
  const res = run(["--schema-only", "--aip", "99", "--slug", "test", "--doctype", "OVERLAP"])
  assert.equal(res.status, 0, res.stderr)
  assert.ok(res.stdout.includes("superRefine"), res.stdout)
  assert.ok(!res.stdout.includes("z.union("), res.stdout)
})

test("a recursive $ref in a oneOf branch is left as z.any(), not expanded forever", (t) => {
  const { tmp, run } = makeFixture(t)
  writeDraft(tmp, "TREE", {
    properties: {
      id: { type: "string" },
      tree: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { $ref: "#/$defs/node" } },
        ],
      },
    },
    $defs: {
      node: {
        oneOf: [{ type: "string" }, { type: "array", items: { $ref: "#/$defs/node" } }],
      },
    },
  })
  const res = run(["--schema-only", "--aip", "99", "--slug", "test", "--doctype", "TREE"])
  assert.equal(res.status, 0, res.stderr)
  assert.ok(res.stdout.includes('"tree": z.union([z.string(), z.array(z.any())])'), res.stdout)
})

// ── --inline-ref <def>: inline one $def, leave the other $refs as z.any() ──
test("--inline-ref inlines only the named def and leaves the other refs as z.any()", (t) => {
  const { tmp, run } = makeFixture(t)
  writeDraft(tmp, "PARTIAL", {
    properties: {
      id: { type: "string" },
      named: { $ref: "#/$defs/wanted" },
      other: { $ref: "#/$defs/skipped" },
    },
    $defs: {
      wanted: { type: "string", minLength: 4 },
      skipped: { type: "string", minLength: 9 },
    },
  })
  const argv = ["--schema-only", "--aip", "99", "--slug", "test", "--doctype", "PARTIAL"]
  const plain = run(argv)
  assert.equal(plain.status, 0, plain.stderr)
  assert.ok(plain.stdout.includes('"named": z.any()'), plain.stdout)

  const res = run([...argv, "--inline-ref", "wanted"])
  assert.equal(res.status, 0, res.stderr)
  assert.ok(res.stdout.includes('"named": z.string().min(4)'), res.stdout)
  assert.ok(res.stdout.includes('"other": z.any()'), res.stdout)
})

test("--inline-ref inlines the refs held inside the named def", (t) => {
  const { tmp, run } = makeFixture(t)
  writeDraft(tmp, "NESTED", {
    properties: {
      id: { type: "string" },
      items: { type: "array", items: { $ref: "#/$defs/outer" } },
    },
    $defs: {
      outer: { oneOf: [{ $ref: "#/$defs/inner" }, { type: "number" }] },
      inner: { type: "string", minLength: 2 },
    },
  })
  const res = run(["--schema-only", "--aip", "99", "--slug", "test", "--doctype", "NESTED", "--inline-ref", "outer"])
  assert.equal(res.status, 0, res.stderr)
  assert.ok(res.stdout.includes("z.string().min(2)"), res.stdout)
  assert.ok(!res.stdout.includes("z.any()"), res.stdout)
})

// ── oneOf of closed objects that cannot both match ───────────────────
test("a oneOf of a closed object and an object requiring a key it does not declare renders a union", (t) => {
  const { tmp, run } = makeFixture(t)
  writeDraft(tmp, "CLOSED", {
    properties: {
      id: { type: "string" },
      item: {
        oneOf: [
          { type: "string" },
          {
            type: "object",
            properties: { ref: { type: "string" } },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["server"],
            properties: { server: { type: "string" } },
            additionalProperties: false,
          },
        ],
      },
    },
  })
  const res = run(["--schema-only", "--aip", "99", "--slug", "test", "--doctype", "CLOSED"])
  assert.equal(res.status, 0, res.stderr)
  assert.ok(!res.stdout.includes("superRefine"), res.stdout)
  assert.match(res.stdout, /"item": z\.union\(\[z\.string\(\), z\.object\(/, res.stdout)
})

test("a oneOf of open objects is not provably disjoint and keeps the exactly-one check", (t) => {
  const { tmp, run } = makeFixture(t)
  writeDraft(tmp, "OPENOBJ", {
    properties: {
      id: { type: "string" },
      item: {
        oneOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { type: "object", required: ["b"], properties: { b: { type: "string" } } },
        ],
      },
    },
  })
  const res = run(["--schema-only", "--aip", "99", "--slug", "test", "--doctype", "OPENOBJ"])
  assert.equal(res.status, 0, res.stderr)
  assert.ok(res.stdout.includes("superRefine"), res.stdout)
})

test("a oneOf of a const and its own primitive type is not disjoint and keeps the exactly-one check", (t) => {
  const { tmp, run } = makeFixture(t)
  writeDraft(tmp, "CONSTOVERLAP", {
    properties: {
      id: { type: "string" },
      pick: { oneOf: [{ const: "x" }, { type: "string" }] },
    },
  })
  const res = run(["--schema-only", "--aip", "99", "--slug", "test", "--doctype", "CONSTOVERLAP"])
  assert.equal(res.status, 0, res.stderr)
  assert.ok(res.stdout.includes("superRefine"), res.stdout)
})

test("a oneOf of integer and number is not disjoint and keeps the exactly-one check", (t) => {
  const { tmp, run } = makeFixture(t)
  writeDraft(tmp, "NUMOVERLAP", {
    properties: {
      id: { type: "string" },
      n: { oneOf: [{ type: "integer" }, { type: "number" }] },
    },
  })
  const res = run(["--schema-only", "--aip", "99", "--slug", "test", "--doctype", "NUMOVERLAP"])
  assert.equal(res.status, 0, res.stderr)
  assert.ok(res.stdout.includes("superRefine"), res.stdout)
})

test("a oneOf of a string-const and a number type stays a plain union", (t) => {
  const { tmp, run } = makeFixture(t)
  writeDraft(tmp, "CONSTDISJOINT", {
    properties: {
      id: { type: "string" },
      pick: { oneOf: [{ const: "x" }, { type: "number" }] },
    },
  })
  const res = run(["--schema-only", "--aip", "99", "--slug", "test", "--doctype", "CONSTDISJOINT"])
  assert.equal(res.status, 0, res.stderr)
  assert.ok(!res.stdout.includes("superRefine"), res.stdout)
})
