import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync, execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { hasProvenanceFooter, waitForProvenanceFooter } from "./check-provenance-footer.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, "..")

const FOOTER = "\n\n---\n<sub>🤖 **@agentproto-bot** — PR · session `sess_1234abcd` · claude-code</sub>"

/** A fake clock: `sleep` advances `now` instead of waiting. */
function fakeClock() {
  let t = 0
  return { now: () => t, sleep: async (ms) => void (t += ms) }
}

test("hasProvenanceFooter matches a rendered footer, not a prose mention", () => {
  assert.equal(hasProvenanceFooter(`body${FOOTER}`), true)
  assert.equal(hasProvenanceFooter("mentions @agentproto-bot in prose"), false)
  assert.equal(hasProvenanceFooter(""), false)
  assert.equal(hasProvenanceFooter(undefined), false)
})

test("a footer already in the initial body passes without polling", async () => {
  let fetches = 0
  const r = await waitForProvenanceFooter({
    initialBody: `body${FOOTER}`,
    fetchBody: () => (fetches++, "x"),
    ...fakeClock(),
  })
  assert.deepEqual(r, { found: true, attempts: 1 })
  assert.equal(fetches, 0)
})

test("a footer stamped after opened passes within the grace period", async () => {
  const bodies = ["body", "body", `body${FOOTER}`]
  const r = await waitForProvenanceFooter({
    initialBody: "body",
    fetchBody: () => bodies.shift(),
    graceMs: 600_000,
    intervalMs: 20_000,
    ...fakeClock(),
  })
  assert.deepEqual(r, { found: true, attempts: 4 })
})

test("a footer that never arrives still fails once the grace period is over", async () => {
  const clock = fakeClock()
  let fetches = 0
  const r = await waitForProvenanceFooter({
    initialBody: "body",
    fetchBody: () => (fetches++, "body"),
    graceMs: 600_000,
    intervalMs: 20_000,
    ...clock,
  })
  assert.equal(r.found, false)
  assert.equal(fetches, 30)
  assert.equal(clock.now(), 600_000)
})

test("a failed fetch is retried, not taken as a verdict", async () => {
  const steps = [() => { throw new Error("502") }, () => `body${FOOTER}`]
  const logs = []
  const r = await waitForProvenanceFooter({
    initialBody: "body",
    fetchBody: () => steps.shift()(),
    log: (m) => logs.push(m),
    ...fakeClock(),
  })
  assert.equal(r.found, true)
  assert.match(logs[0], /502/)
})

test("grace 0 checks the initial body once", async () => {
  let fetches = 0
  const r = await waitForProvenanceFooter({
    initialBody: "body",
    fetchBody: () => (fetches++, `body${FOOTER}`),
    graceMs: 0,
    ...fakeClock(),
  })
  assert.deepEqual(r, { found: false, attempts: 1 })
  assert.equal(fetches, 0)
})

// ── The real ci.yml step, end to end ──────────────────────────────────────

/** The `run: |` script of the Hygiene job's footer step, dedented. */
function hygieneStepScript() {
  const ci = readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8")
  const start = ci.indexOf("- name: Check scratch docs, AI-attribution trailers, and provenance footer")
  assert.ok(start >= 0, "hygiene footer step not found in ci.yml")
  const lines = ci.slice(start).split("\n")
  const runAt = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l))
  const indent = lines[runAt].match(/^\s*/)[0].length + 2
  const body = []
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== "" && line.match(/^\s*/)[0].length < indent) break
    body.push(line.slice(indent))
  }
  return body.join("\n")
}

/**
 * Run the step in a scratch git repo (`origin/main..HEAD` clean, no scratch
 * docs) with a fake `gh` that serves the PR body: footer-less for the first
 * `stampedAfter` calls, stamped afterwards (never, when `stampedAfter` is
 * Infinity).
 */
function runHygieneStep(t, { stampedAfter, graceSeconds }) {
  const dir = mkdtempSync(path.join(tmpdir(), "hygiene-footer-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" })
  git("init", "-q")
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base")
  git("update-ref", "refs/remotes/origin/main", "HEAD")
  symlinkSync(path.join(repoRoot, "scripts"), path.join(dir, "scripts"))

  const bin = path.join(dir, ".bin")
  mkdirSync(bin)
  const counter = path.join(dir, ".gh-calls")
  writeFileSync(counter, "0")
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs")
const n = Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) + 1
fs.writeFileSync(${JSON.stringify(counter)}, String(n))
const stamped = n > ${Number.isFinite(stampedAfter) ? stampedAfter : "Infinity"}
process.stdout.write("PR body" + (stamped ? ${JSON.stringify(FOOTER)} : "") + "\\n")
`,
  )
  chmodSync(path.join(bin, "gh"), 0o755)

  const res = spawnSync("bash", ["-e", "-c", hygieneStepScript()], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      PR_TITLE: "fix: something",
      PR_NUMBER: "42",
      PR_AUTHOR: "agentiknet",
      GH_TOKEN: "x",
      PROVENANCE_GRACE_SECONDS: String(graceSeconds),
      PROVENANCE_POLL_SECONDS: "0.05",
    },
  })
  return { status: res.status, output: `${res.stdout}${res.stderr}` }
}

test("ci.yml hygiene step passes when the footer is stamped after opened", (t) => {
  const r = runHygieneStep(t, { stampedAfter: 2, graceSeconds: 30 })
  assert.equal(r.status, 0, r.output)
  assert.match(r.output, /provenance footer present/)
})

test("ci.yml hygiene step still fails when the footer never arrives", (t) => {
  const r = runHygieneStep(t, { stampedAfter: Infinity, graceSeconds: 0.3 })
  assert.equal(r.status, 1, r.output)
  assert.match(r.output, /carries no agentproto provenance footer/)
})
