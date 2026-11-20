import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { applyBumps, classifyRows, renderBody, rewriteText } from "./bump-adapter-pins.mjs"

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "bump-pins-"))
  const write = (rel, text) => {
    const file = join(dir, rel)
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, text)
  }
  write(
    "alpha/src/index.ts",
    [
      '// run `npx -y @example/alpha-acp@1.2.0`',
      'bin_args: ["-y", "@example/alpha-acp@1.2.0"],',
      'install: [{ method: "npm", package: "@example/alpha-acp@1.2.0" }],',
      'version_check: { cmd: "npm ls -g @example/alpha-acp", range: "=1.2.0" },',
      "// history: 1.2.0 fixed a bug, and 11.2.0 is unrelated @example/alpha-acp@1.2.01",
    ].join("\n"),
  )
  write("alpha/src/__tests__/pin.test.ts", 'expect("@example/alpha-acp@1.2.0")')
  write("alpha/README.md", "npx -y @example/alpha-acp@1.2.0.")
  write("alpha/CHANGELOG.md", "pinned @example/alpha-acp@1.2.0 once")
  write(
    "floor/src/index.ts",
    'bin_args: ["-y", "beta-cli"],\nversion_check: { cmd: "npm view beta-cli version", range: ">=1.0.0" },',
  )
  write("major/src/index.ts", 'bin_args: ["-y", "gamma@1.0.0"],')
  return { dir, write, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const rows = [
  { adapter: "alpha", package: "@example/alpha-acp", pinned: "1.2.0", latest: "1.4.1", drift: "minor" },
  { adapter: "floor", package: "beta-cli", pinned: "1.0.0", latest: "1.0.3", drift: "patch" },
  { adapter: "major", package: "gamma", pinned: "1.0.0", latest: "2.0.0", drift: "major" },
  { adapter: "same", package: "delta", pinned: "3.0.0", latest: "3.0.0", drift: "none" },
  { adapter: "ahead", package: "eps", pinned: "4.0.0", latest: "3.9.0", drift: "ahead" },
  { adapter: "unk", package: "zeta", pinned: "1.0.0", latest: null, drift: "unknown" },
]

test("classifies minor and patch as candidates and holds majors back", () => {
  const { candidates, heldMajor } = classifyRows(rows)
  assert.deepEqual(candidates.map((r) => r.adapter), ["alpha", "floor"])
  assert.deepEqual(heldMajor.map((r) => r.adapter), ["major"])
})

test("rewrites pkg@version and the exact range guard, nothing else", () => {
  const source = fixtureDir()
  try {
    const { text, count } = rewriteText(
      readFileSync(join(source.dir, "alpha/src/index.ts"), "utf8"),
      "@example/alpha-acp",
      "1.2.0",
      "1.4.1",
    )
    assert.equal(count, 3)
    assert.match(text, /bin_args: \["-y", "@example\/alpha-acp@1\.4\.1"\]/)
    assert.match(text, /range: "=1\.4\.1"/)
    // a longer version that merely starts with the old one is untouched
    assert.match(text, /alpha-acp@1\.2\.01/)
    // prose that only mentions the bare version is untouched
    assert.match(text, /history: 1\.2\.0 fixed/)
  } finally {
    source.cleanup()
  }
})

test("applyBumps edits src, tests and docs but not CHANGELOG, and reports the rest", () => {
  const source = fixtureDir()
  try {
    const plan = applyBumps(rows, source.dir)
    assert.deepEqual(plan.bumped.map((b) => b.adapter), ["alpha"])
    assert.deepEqual(plan.bumped[0].files.sort(), [
      "alpha/README.md",
      "alpha/src/__tests__/pin.test.ts",
      "alpha/src/index.ts",
    ])
    assert.equal(readFileSync(join(source.dir, "alpha/CHANGELOG.md"), "utf8"), "pinned @example/alpha-acp@1.2.0 once")
    assert.equal(readFileSync(join(source.dir, "alpha/README.md"), "utf8"), "npx -y @example/alpha-acp@1.4.1.")
    assert.equal(plan.floorOnly.length, 1)
    assert.equal(plan.floorOnly[0].adapter, "floor")
    // the floor-only adapter must be left byte-for-byte alone
    assert.match(readFileSync(join(source.dir, "floor/src/index.ts"), "utf8"), /range: ">=1\.0\.0"/)
    assert.deepEqual(plan.heldMajor.map((m) => m.adapter), ["major"])
    assert.match(readFileSync(join(source.dir, "major/src/index.ts"), "utf8"), /gamma@1\.0\.0/)
  } finally {
    source.cleanup()
  }
})

test("dry run reports the plan without writing", () => {
  const source = fixtureDir()
  try {
    const before = readFileSync(join(source.dir, "alpha/src/index.ts"), "utf8")
    const plan = applyBumps(rows, source.dir, { dryRun: true })
    assert.equal(plan.bumped.length, 1)
    assert.equal(readFileSync(join(source.dir, "alpha/src/index.ts"), "utf8"), before)
  } finally {
    source.cleanup()
  }
})

test("a second run is a no-op once the rows are fresh", () => {
  const source = fixtureDir()
  try {
    applyBumps(rows, source.dir)
    const fresh = rows.map((r) => (r.adapter === "alpha" ? { ...r, pinned: "1.4.1", drift: "none" } : r))
    assert.equal(applyBumps(fresh, source.dir).bumped.length, 0)
  } finally {
    source.cleanup()
  }
})

test("a missing adapter directory is reported, not thrown", () => {
  const source = fixtureDir()
  try {
    const plan = applyBumps(
      [{ adapter: "ghost", package: "p", pinned: "1.0.0", latest: "1.0.1", drift: "patch" }],
      source.dir,
    )
    assert.equal(plan.bumped.length, 0)
    assert.equal(plan.floorOnly[0].reason, "adapter directory not found")
  } finally {
    source.cleanup()
  }
})

test("renderBody names bumped, held-back and floor-only adapters and the credentials", () => {
  const source = fixtureDir()
  try {
    const body = renderBody(applyBumps(rows, source.dir))
    assert.match(body, /\| alpha \| `@example\/alpha-acp` \| 1\.2\.0 \| 1\.4\.1 \| minor \|/)
    assert.match(body, /Major drift, NOT bumped/)
    assert.match(body, /\| major \| `gamma` \| 1\.0\.0 \| 2\.0\.0 \|/)
    assert.match(body, /no explicit spawn pin/)
    assert.match(body, /skipped: no credential/)
    assert.ok(!body.includes(String.fromCharCode(0x2014)), "no em dash")
  } finally {
    source.cleanup()
  }
})
