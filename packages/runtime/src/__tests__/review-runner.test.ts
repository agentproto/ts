/**
 * review-runner.ts + review-tools.ts against a REAL temp git repo: range
 * resolution, the compiled review workflow running through the real
 * workflow-runtime, command lanes as real subprocesses, the ledger (cache
 * hits, never caching incomplete/dirty), prepare-before-freeze, cancel, and
 * the MCP tool surface. Agent lanes go through a fake `ReviewerSessionHost`
 * that plays the reviewer by writing the verdict file the prompt names — the
 * real session-backed host has its own e2e (review-reviewer-host.test.ts).
 */

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { ledgerKeyOf, rangeSha, verifyAttestation, type Attestation } from "@agentproto/review"
import { createReviewLedger } from "../review-ledger.js"
import {
  createReviewRunner,
  normalizeRemote,
  type ReviewerSessionHost,
  type ReviewRunner,
} from "../review-runner.js"
import { registerReviewTools } from "../review-tools.js"

// Real git + subprocesses (+ sessions) per test: the 5s default is too tight
// on a loaded machine or CI runner.
vi.setConfig({ testTimeout: 30_000 })

/** git in `cwd`. Retries a held `index.lock`: tests that commit while a run
 *  is in flight race the runner's own `git status` (which refreshes the
 *  index under that lock). */
const sh = (cwd: string, ...args: string[]): string => {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    } catch (err) {
      if (attempt >= 40 || !/index\.lock/.test(String((err as { stderr?: unknown }).stderr ?? err))) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

const RUBRIC = "# rubric\nFind bugs.\n"

function manifest(checks: string[], bindings?: string[], extra: string[] = []): string {
  return [
    "---",
    "kind: review",
    "id: demo",
    "target: {kind: git-range, base: main}",
    "checks:",
    ...checks.map((c) => `  - ${c}`),
    ...(bindings ? ["bindings:", ...bindings.map((b) => `  ${b}`)] : []),
    ...extra,
    "---",
    "",
    "Demo review.",
  ].join("\n")
}

/** main (base) ← feature (one commit). Remote origin set for identity only. */
async function makeRepo(review: string): Promise<{ dir: string; baseSha: string; headSha: string }> {
  // realpath: git reports the resolved toplevel (macOS /var → /private/var).
  const dir = await realpath(await mkdtemp(join(tmpdir(), "agp-review-repo-")))
  sh(dir, "init", "-q", "-b", "main")
  sh(dir, "config", "user.email", "t@example.com")
  sh(dir, "config", "user.name", "t")
  sh(dir, "config", "commit.gpgsign", "false")
  await writeFile(join(dir, "REVIEW.md"), review)
  await mkdir(join(dir, "rubrics"))
  await writeFile(join(dir, "rubrics", "correctness.md"), RUBRIC)
  await writeFile(join(dir, "a.txt"), "a\n")
  sh(dir, "add", "-A")
  sh(dir, "commit", "-qm", "base")
  const baseSha = sh(dir, "rev-parse", "HEAD")
  sh(dir, "checkout", "-qb", "feature")
  await writeFile(join(dir, "b.txt"), "b\n")
  sh(dir, "add", "-A")
  sh(dir, "commit", "-qm", "change")
  sh(dir, "remote", "add", "origin", "git@github.com:acme/demo.git")
  return { dir, baseSha, headSha: sh(dir, "rev-parse", "HEAD") }
}

/** Fake reviewer: writes `report` to the verdict path the prompt names. */
function fakeReviewers(report: unknown | ((prompt: string) => unknown)) {
  const calls: Array<{ preset: string; cwd: string; prompt: string; label: string; parentSessionId?: string }> = []
  const host: ReviewerSessionHost = {
    async run(input) {
      calls.push(input)
      const path = input.prompt.match(/write EXACTLY ONE file — (\S+) —/)?.[1]
      if (!path) throw new Error("prompt names no verdict path")
      const body = typeof report === "function" ? (report as (p: string) => unknown)(input.prompt) : report
      await writeFile(path, JSON.stringify(body))
      return { status: "ended", sessionId: `sess-${calls.length}`, preset: input.preset }
    },
  }
  return { host, calls }
}

let ledgerRoot: string
const cleanup: string[] = []

beforeEach(async () => {
  ledgerRoot = await mkdtemp(join(tmpdir(), "agp-review-ledger-"))
  cleanup.push(ledgerRoot)
})
afterEach(async () => {
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true })
})

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitFor: condition not met in time")
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function runToEnd(runner: ReviewRunner, input: Parameters<ReviewRunner["start"]>[0]) {
  const run = runner.start(input)
  return (await runner.wait(run.runId))!
}

describe("normalizeRemote", () => {
  it("makes SSH and HTTPS clones agree and strips credentials", () => {
    expect(normalizeRemote("git@github.com:agentproto/ts.git")).toBe("github.com/agentproto/ts")
    expect(normalizeRemote("https://token@github.com/agentproto/ts.git")).toBe("github.com/agentproto/ts")
    expect(normalizeRemote("ssh://git@github.com/agentproto/ts/")).toBe("github.com/agentproto/ts")
  })
})

describe("review runner — verdicts over a real repo", () => {
  it("runs command + agent lanes in parallel, attests the range, writes the ledger", async () => {
    const repo = await makeRepo(
      manifest([
        '{id: files, kind: command, run: "test -f b.txt"}',
        "{id: correctness, kind: agent, preset: kimi, rubric: ./rubrics/correctness.md}",
      ]),
    )
    cleanup.push(repo.dir)
    const { host, calls } = fakeReviewers({
      decision: "approve",
      summary: "fine",
      findings: [{ severity: "medium", title: "nit", file: "b.txt", line: 1 }],
    })
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }), reviewers: host, daemonId: "test-daemon" })
    const run = await runToEnd(runner, { cwd: repo.dir, parentSessionId: "parent-1" })

    expect(run.status).toBe("done")
    const att = run.attestation!
    expect(att.verdict).toBe("pass")
    expect(att.target).toEqual({ repoRemote: "github.com/acme/demo", baseSha: repo.baseSha, headSha: repo.headSha })
    expect(att.lanes.map((l) => [l.id, l.status])).toEqual([
      ["files", "pass"],
      ["correctness", "pass"],
    ])
    expect(att.lanes[1]).toMatchObject({ sessionId: "sess-1", preset: "kimi", summary: "fine" })
    expect(att.attestor).toMatchObject({ daemon: "test-daemon", presets: ["kimi"] })
    // Only the daemon signs (Goal A): every attestation a run writes is
    // signed by default in these tests (real `ssh-keygen`, hermetic $HOME).
    expect(att.attestor.signature).toMatchObject({ alg: "ssh-ed25519", principal: "t@example.com" })
    expect(att.rubrics).toEqual([
      { check: "correctness", path: "./rubrics/correctness.md", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ])
    expect(att.dirty).toBeUndefined()

    // Pointer-style prompt; reviewer spawned in the repo, nested under the caller.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ preset: "kimi", label: "review:demo:correctness", parentSessionId: "parent-1" })
    expect(calls[0]!.prompt).toContain(`${repo.baseSha}..${repo.headSha}`)
    expect(calls[0]!.prompt).toContain(join(repo.dir, "rubrics", "correctness.md"))
    // The verdict file lives in the ledger's run dir — never the reviewed tree
    // — and is cleaned up after the run.
    expect(calls[0]!.prompt).toContain(ledgerRoot)
    expect(sh(repo.dir, "status", "--porcelain")).toBe("")
    expect(existsSync(join(ledgerRoot, "github.com_acme_demo", "runs", run.runId))).toBe(false)
    expect(run.ledgerPath).toBe(
      join(ledgerRoot, "github.com_acme_demo", att.manifestSha, "default", `${att.rangeSha}.json`),
    )
    expect(JSON.parse(await readFile(run.ledgerPath!, "utf8")).attestation.runId).toBe(run.runId)
  })

  it("serves a clean verdict from the ledger; nocache re-runs", async () => {
    const repo = await makeRepo(manifest(["{id: correctness, kind: agent, preset: kimi, rubric: ./rubrics/correctness.md}"]))
    cleanup.push(repo.dir)
    const { host, calls } = fakeReviewers({ findings: [{ severity: "high", title: "bug" }] })
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }), reviewers: host })

    const first = await runToEnd(runner, { cwd: repo.dir })
    expect(first.attestation!.verdict).toBe("block")
    const second = await runToEnd(runner, { cwd: repo.dir })
    expect(second.cached).toBe(true)
    expect(second.attestation!.runId).toBe(first.runId)
    expect(calls).toHaveLength(1)

    const third = await runToEnd(runner, { cwd: repo.dir, nocache: true })
    expect(third.cached).toBeUndefined()
    expect(calls).toHaveLength(2)
  })

  it("a rubric edit invalidates the cached verdict (same range, clean tree)", async () => {
    // The rubric is UNTRACKED, so editing it moves neither the range nor the
    // dirty flag — only the rubric digest can tell the two runs apart.
    const repo = await makeRepo(manifest(["{id: correctness, kind: agent, preset: kimi, rubric: ./rubrics/local.md}"]))
    cleanup.push(repo.dir)
    await writeFile(join(repo.dir, "rubrics", "local.md"), RUBRIC)
    const { host, calls } = fakeReviewers({ findings: [] })
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }), reviewers: host })
    await runToEnd(runner, { cwd: repo.dir })
    expect((await runToEnd(runner, { cwd: repo.dir })).cached).toBe(true)
    await writeFile(join(repo.dir, "rubrics", "local.md"), `${RUBRIC}Also check perf.\n`)
    const again = await runToEnd(runner, { cwd: repo.dir })
    expect(again.cached).toBeUndefined()
    expect(calls).toHaveLength(2)
  })

  it("a timed-out lane makes the verdict incomplete, and incomplete is never cached", async () => {
    const repo = await makeRepo(
      manifest(['{id: ok, kind: command, run: "true"}', '{id: slow, kind: command, run: "sleep 5", timeoutMs: 200}']),
    )
    cleanup.push(repo.dir)
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) })
    const first = await runToEnd(runner, { cwd: repo.dir })
    expect(first.attestation!.verdict).toBe("incomplete")
    expect(first.attestation!.lanes[1]).toMatchObject({ id: "slow", status: "timeout" })
    expect(first.attestation!.lanes[1]!.error).toMatch(/exceeded 200ms/)
    const second = await runToEnd(runner, { cwd: repo.dir })
    expect(second.cached).toBeUndefined()
    expect(second.runId).not.toBe(first.runId)
  })

  it("a failing blocking command blocks; the finding carries the output tail", async () => {
    const repo = await makeRepo(manifest(['{id: types, kind: command, run: "echo TS2322 >&2; exit 2"}']))
    cleanup.push(repo.dir)
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) })
    const run = await runToEnd(runner, { cwd: repo.dir })
    expect(run.attestation!.verdict).toBe("block")
    expect(run.attestation!.lanes[0]).toMatchObject({
      status: "fail",
      exitCode: 2,
      findings: [{ severity: "high", title: "'types' exited with code 2" }],
    })
    expect(run.attestation!.lanes[0]!.findings[0]!.detail).toContain("TS2322")
  })

  it("binds {changed} and {base}/{head} in command lanes", async () => {
    const repo = await makeRepo(
      manifest([
        `{id: vars, kind: command, run: 'test {changed} = "[$(git rev-parse main)]" && test {head} = "$(git rev-parse HEAD)" && test {base} = "$(git rev-parse main)"'}`,
      ]),
    )
    cleanup.push(repo.dir)
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) })
    const run = await runToEnd(runner, { cwd: repo.dir })
    expect(run.attestation!.lanes[0]!.error).toBeUndefined()
    expect(run.attestation!.verdict).toBe("pass")
  })

  it("records a dirty-tree review but never serves it from cache", async () => {
    const repo = await makeRepo(manifest(['{id: ok, kind: command, run: "true"}']))
    cleanup.push(repo.dir)
    await writeFile(join(repo.dir, "a.txt"), "edited\n")
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) })
    const first = await runToEnd(runner, { cwd: repo.dir })
    expect(first.attestation!.dirty).toBe(true)
    sh(repo.dir, "checkout", "--", "a.txt")
    const second = await runToEnd(runner, { cwd: repo.dir })
    expect(second.cached).toBeUndefined()
    expect(second.attestation!.dirty).toBeUndefined()
  })

  it("runs prepare BEFORE freezing: a prepare commit lands in the attested head", async () => {
    const repo = await makeRepo(
      manifest(
        [
          '{id: stamp, kind: command, run: "echo s > stamp.txt && git add stamp.txt && git commit -qm stamp", effects: true}',
          '{id: stamped, kind: command, run: "test -f stamp.txt"}',
        ],
        ["local: {prepare: [stamp], checks: [stamped]}"],
      ),
    )
    cleanup.push(repo.dir)
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) })
    const run = await runToEnd(runner, { cwd: repo.dir, binding: "local" })
    const newHead = sh(repo.dir, "rev-parse", "HEAD")
    expect(newHead).not.toBe(repo.headSha)
    expect(run.attestation!.target.headSha).toBe(newHead)
    expect(run.attestation!.verdict).toBe("pass")
    // Next run: the pre-check sees the already-stamped head → cache hit,
    // prepare doesn't run again.
    const again = await runToEnd(runner, { cwd: repo.dir, binding: "local" })
    expect(again.cached).toBe(true)
    expect(sh(repo.dir, "rev-parse", "HEAD")).toBe(newHead)
  })

  it("agent lanes are skipped (incomplete) when no reviewer host is wired", async () => {
    const repo = await makeRepo(manifest(["{id: correctness, kind: agent, preset: kimi, rubric: ./rubrics/correctness.md}"]))
    cleanup.push(repo.dir)
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) })
    const run = await runToEnd(runner, { cwd: repo.dir })
    expect(run.attestation!.verdict).toBe("incomplete")
    expect(run.attestation!.lanes[0]!.error).toMatch(/agent lanes are not available/)
  })

  it("an agent lane with no verdict file, or a missing rubric, is skipped", async () => {
    const repo = await makeRepo(
      manifest([
        "{id: silent, kind: agent, preset: kimi, rubric: ./rubrics/correctness.md}",
        "{id: norubric, kind: agent, preset: kimi, rubric: ./rubrics/missing.md}",
      ]),
    )
    cleanup.push(repo.dir)
    const host: ReviewerSessionHost = { run: async (i) => ({ status: "ended", sessionId: "s", preset: i.preset }) }
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }), reviewers: host })
    const run = await runToEnd(runner, { cwd: repo.dir })
    expect(run.attestation!.verdict).toBe("incomplete")
    expect(run.attestation!.lanes[0]!.error).toMatch(/without writing/)
    expect(run.attestation!.lanes[1]!.error).toMatch(/rubric not found/)
  })

  it("cancel kills running lanes and ends the run cancelled", async () => {
    const repo = await makeRepo(manifest(['{id: slow, kind: command, run: "sleep 30"}']))
    cleanup.push(repo.dir)
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) })
    const run = runner.start({ cwd: repo.dir })
    await new Promise((r) => setTimeout(r, 300))
    expect(runner.cancel(run.runId)).toBe(true)
    const done = (await runner.wait(run.runId))!
    expect(done.status).toBe("cancelled")
    // A cancelled run records NOTHING: no attestation, no ledger entry.
    expect(done.attestation).toBeUndefined()
    expect(done.lanes[0]).toMatchObject({ status: "skipped" })
    expect(await runner.ledger.list()).toEqual([])
    expect(runner.cancel(run.runId)).toBe(false)
  })

  it("records the requester (caller session + head author) and the reviewer's model", async () => {
    const repo = await makeRepo(
      manifest(["{id: correctness, kind: agent, preset: kimi, rubric: ./rubrics/correctness.md}"]),
    )
    cleanup.push(repo.dir)
    const host: ReviewerSessionHost = {
      async run(input) {
        const path = input.prompt.match(/write EXACTLY ONE file — (\S+) —/)![1]!
        await writeFile(path, JSON.stringify({ findings: [] }))
        return { status: "ended", sessionId: "rev-1", preset: input.preset, model: "kimi-k2" }
      },
    }
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }), reviewers: host })
    const run = await runToEnd(runner, { cwd: repo.dir, parentSessionId: "caller-1" })
    expect(run.attestation!.requester).toEqual({
      sessionId: "caller-1",
      gitAuthor: { name: "t", email: "t@example.com" },
    })
    expect(run.attestation!.lanes[0]).toMatchObject({ sessionId: "rev-1", preset: "kimi", model: "kimi-k2" })

    // An explicit requester overrides the parent session.
    const again = await runToEnd(runner, {
      cwd: repo.dir,
      parentSessionId: "caller-1",
      requesterSessionId: "gate-7",
      nocache: true,
    })
    expect(again.attestation!.requester!.sessionId).toBe("gate-7")
  })

  it("hands a lane's fallbackPresets to the host and records the reviewer that actually ran", async () => {
    const repo = await makeRepo(
      manifest([
        "{id: correctness, kind: agent, preset: kimi, fallbackPresets: [glm, claude], rubric: ./rubrics/correctness.md}",
        "{id: plain, kind: agent, preset: kimi, rubric: ./rubrics/correctness.md}",
      ]),
    )
    cleanup.push(repo.dir)
    const seen: Array<{ preset: string; fallbackPresets?: string[] }> = []
    const host: ReviewerSessionHost = {
      async run(input) {
        seen.push({ preset: input.preset, ...(input.fallbackPresets ? { fallbackPresets: input.fallbackPresets } : {}) })
        const path = input.prompt.match(/write EXACTLY ONE file — (\S+) —/)![1]!
        // A `block` verdict from the fallback reviewer is final.
        await writeFile(
          path,
          JSON.stringify({ findings: [{ severity: "high", title: "bug", detail: "d" }] }),
        )
        return input.fallbackPresets
          ? {
              status: "ended",
              sessionId: "rev-glm",
              preset: "glm",
              model: "glm-5",
              fallbacks: [{ preset: "kimi", error: "reviewer produced an empty turn" }],
            }
          : { status: "ended", sessionId: "rev-kimi", preset: input.preset }
      },
    }
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }), reviewers: host })
    const run = await runToEnd(runner, { cwd: repo.dir })
    expect(seen).toContainEqual({ preset: "kimi", fallbackPresets: ["glm", "claude"] })
    expect(seen).toContainEqual({ preset: "kimi" })
    const att = run.attestation!
    expect(att.verdict).toBe("block")
    const lane = att.lanes.find((l) => l.id === "correctness")!
    expect(lane).toMatchObject({
      status: "fail",
      sessionId: "rev-glm",
      preset: "glm",
      model: "glm-5",
      fallbacks: [{ preset: "kimi", error: "reviewer produced an empty turn" }],
    })
    expect(att.lanes.find((l) => l.id === "plain")!.fallbacks).toBeUndefined()
    expect([...att.attestor.presets].sort()).toEqual(["glm", "kimi"])
    // The fallback record is part of the signed-able attestation payload and still verifies.
    expect(verifyAttestation(att)).toMatchObject({ ok: true })
  })

  it("an exhausted reviewer chain skips the lane (incomplete) and keeps every error", async () => {
    const repo = await makeRepo(
      manifest(["{id: correctness, kind: agent, preset: kimi, fallbackPresets: [glm], rubric: ./rubrics/correctness.md}"]),
    )
    cleanup.push(repo.dir)
    const host: ReviewerSessionHost = {
      run: async () => ({
        status: "failed",
        preset: "glm",
        error: "every reviewer in the chain was unavailable — 'kimi': boom; 'glm': bang",
        fallbacks: [{ preset: "kimi", error: "boom" }],
      }),
    }
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }), reviewers: host })
    const run = await runToEnd(runner, { cwd: repo.dir })
    expect(run.attestation!.verdict).toBe("incomplete")
    expect(run.attestation!.lanes[0]).toMatchObject({
      status: "skipped",
      preset: "glm",
      error: expect.stringContaining("'kimi': boom; 'glm': bang"),
      fallbacks: [{ preset: "kimi", error: "boom" }],
    })
  })

  it("records a passed-through pr in the attestation AND as the ledger annotation link", async () => {
    const repo = await makeRepo(manifest(['{id: ok, kind: command, run: "true"}']))
    cleanup.push(repo.dir)
    const ledger = createReviewLedger({ root: ledgerRoot })
    const runner = createReviewRunner({ ledger })
    const pr = { provider: "github" as const, repo: "acme/demo", number: 7, url: "https://github.com/acme/demo/pull/7" }
    const run = await runToEnd(runner, { cwd: repo.dir, pr })
    expect(run.attestation!.pr).toEqual(pr)
    const key = ledgerKeyOf(run.attestation!)
    expect(await ledger.getAnnotations(key)).toEqual({ pr })
    // The sidecar never shows up as a ledger entry of its own.
    expect(await ledger.list()).toHaveLength(1)
  })

  it("does not join an in-flight run once HEAD has moved on (a new push is a new range)", async () => {
    const repo = await makeRepo(manifest(['{id: slow, kind: command, run: "sleep 30"}']))
    cleanup.push(repo.dir)
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) })
    const a = runner.start({ cwd: repo.dir })
    await waitFor(() => a.headSha !== undefined)
    await writeFile(join(repo.dir, "c.txt"), "c\n")
    sh(repo.dir, "add", "-A")
    sh(repo.dir, "commit", "-qm", "next")
    const b = runner.start({ cwd: repo.dir })
    expect(b.runId).not.toBe(a.runId)
    runner.cancel(a.runId)
    runner.cancel(b.runId)
    await Promise.all([runner.wait(a.runId), runner.wait(b.runId)])
  })

  it("supersede: a run for a NEW head cancels the older head's in-flight run, which writes nothing", async () => {
    // The lane marks (outside the tree) that it started on the frozen head,
    // then only finishes quickly for a head that contains c.txt.
    const repo = await makeRepo(
      manifest(['{id: lane, kind: command, run: "touch ../{head}.started; git cat-file -e {head}:c.txt || sleep 30"}']),
    )
    cleanup.push(repo.dir, join(repo.dir, "..", `${repo.headSha}.started`))
    const ledger = createReviewLedger({ root: ledgerRoot })
    const runner = createReviewRunner({ ledger })
    const older = runner.start({ cwd: repo.dir, supersede: true })
    await waitFor(() => existsSync(join(repo.dir, "..", `${repo.headSha}.started`)))
    const oldHead = older.headSha!
    expect(oldHead).toBe(repo.headSha)
    await writeFile(join(repo.dir, "c.txt"), "c\n")
    sh(repo.dir, "add", "-A")
    sh(repo.dir, "commit", "-qm", "next push")
    const newer = runner.start({ cwd: repo.dir, supersede: true })
    const [o, n] = await Promise.all([runner.wait(older.runId), runner.wait(newer.runId)])
    expect(o).toMatchObject({ status: "cancelled", supersededBy: newer.runId })
    expect(o!.attestation).toBeUndefined()
    expect(n).toMatchObject({ status: "done" })
    expect(n!.attestation!.verdict).toBe("pass")
    const entries = await ledger.list()
    expect(entries.map((e) => e.attestation.runId)).toEqual([newer.runId])
    expect(entries[0]!.attestation.target.headSha).not.toBe(oldHead)
  })

  it("supersede never cancels a sibling branch reviewed from another worktree off the same base", async () => {
    const repo = await makeRepo(manifest(['{id: slow, kind: command, run: "sleep 30"}']))
    cleanup.push(repo.dir)
    const sibling = `${repo.dir}-sibling`
    cleanup.push(sibling)
    sh(repo.dir, "worktree", "add", "-q", "-b", "sibling", sibling, "main")
    await writeFile(join(sibling, "s.txt"), "s\n")
    sh(sibling, "add", "-A")
    sh(sibling, "commit", "-qm", "sibling change")
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) })
    const a = runner.start({ cwd: repo.dir, supersede: true })
    await waitFor(() => a.headSha !== undefined)
    const b = runner.start({ cwd: sibling, supersede: true })
    await waitFor(() => b.headSha !== undefined)
    // Same repo, binding and base, different heads — but not the same line.
    expect(b.baseSha).toBe(a.baseSha)
    await new Promise((r) => setTimeout(r, 300))
    expect(a.status).toBe("running")
    expect(a.supersededBy).toBeUndefined()
    runner.cancel(a.runId)
    runner.cancel(b.runId)
    await Promise.all([runner.wait(a.runId), runner.wait(b.runId)])
  })

  it("supersede leaves a different binding, and a run without the flag, alone", async () => {
    const repo = await makeRepo(
      manifest(['{id: slow, kind: command, run: "sleep 30"}', '{id: quick, kind: command, run: "true"}'], [
        "local: {checks: [slow]}",
        "ci: {checks: [quick]}",
      ]),
    )
    cleanup.push(repo.dir)
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) })
    const local = runner.start({ cwd: repo.dir, binding: "local" })
    await waitFor(() => local.headSha !== undefined)
    await writeFile(join(repo.dir, "c.txt"), "c\n")
    sh(repo.dir, "add", "-A")
    sh(repo.dir, "commit", "-qm", "next")
    const ci = await runToEnd(runner, { cwd: repo.dir, binding: "ci", supersede: true })
    expect(ci.status).toBe("done")
    expect(local.status).toBe("running")
    runner.cancel(local.runId)
    await runner.wait(local.runId)
  })

  it("joins an identical in-flight request instead of starting a second run", async () => {
    const repo = await makeRepo(manifest(['{id: slow, kind: command, run: "sleep 0.3"}']))
    cleanup.push(repo.dir)
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) })
    const a = runner.start({ cwd: repo.dir })
    const b = runner.start({ cwd: repo.dir })
    expect(b.runId).toBe(a.runId)
    await runner.wait(a.runId)
  })

  it("fails the run with a clear error when there is no REVIEW.md", async () => {
    const repo = await makeRepo(manifest(['{id: ok, kind: command, run: "true"}']))
    cleanup.push(repo.dir)
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) })
    const run = await runToEnd(runner, { cwd: repo.dir, manifestPath: "nope/REVIEW.md" })
    expect(run.status).toBe("failed")
    expect(run.error).toMatch(/no REVIEW.md at .*nope\/REVIEW.md/)
  })

  it("list() reports running + settled-in-this-process runs, newest first, with requesterSessionId", async () => {
    const repo = await makeRepo(manifest(['{id: slow, kind: command, run: "sleep 0.3"}']))
    cleanup.push(repo.dir)
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) })
    const a = runner.start({ cwd: repo.dir, requesterSessionId: "req-a" })
    expect(runner.list().find((r) => r.runId === a.runId)).toMatchObject({ status: "running", requesterSessionId: "req-a" })
    await runner.wait(a.runId)
    const done = runner.list().find((r) => r.runId === a.runId)!
    expect(done.status).toBe("done")
    expect(done.requesterSessionId).toBe("req-a")

    const repo2 = await makeRepo(manifest(['{id: ok, kind: command, run: "true"}']))
    cleanup.push(repo2.dir)
    const b = await runToEnd(runner, { cwd: repo2.dir, parentSessionId: "req-b" })
    // parentSessionId is the fallback requester when requesterSessionId is unset.
    expect(runner.list().find((r) => r.runId === b.runId)?.requesterSessionId).toBe("req-b")
    // Newest first.
    const ids = runner.list().map((r) => r.runId)
    expect(ids.indexOf(b.runId)).toBeLessThan(ids.indexOf(a.runId))
  })

  it("notifyRequester fires once a run with a requester reaches done, never for a cancelled/failed run", async () => {
    const repo = await makeRepo(manifest(['{id: ok, kind: command, run: "true"}']))
    cleanup.push(repo.dir)
    const notified: Array<{ sessionId: string; text: string }> = []
    const runner = createReviewRunner({
      ledger: createReviewLedger({ root: ledgerRoot }),
      notifyRequester: (sessionId, text) => notified.push({ sessionId, text }),
    })
    const done = await runToEnd(runner, { cwd: repo.dir, requesterSessionId: "watcher-1" })
    expect(notified).toHaveLength(1)
    expect(notified[0]!.sessionId).toBe("watcher-1")
    expect(notified[0]!.text).toBe(
      `review pass ${repo.baseSha.slice(0, 7)}..${repo.headSha.slice(0, 7)} (${done.runId})`,
    )

    // A run with NO requester never notifies (nothing to notify).
    const repo2 = await makeRepo(manifest(['{id: ok, kind: command, run: "true"}']))
    cleanup.push(repo2.dir)
    await runToEnd(runner, { cwd: repo2.dir })
    expect(notified).toHaveLength(1)

    // A failed run (no REVIEW.md) never notifies even with a requester.
    const repo3 = await makeRepo(manifest(['{id: ok, kind: command, run: "true"}']))
    cleanup.push(repo3.dir)
    await runToEnd(runner, { cwd: repo3.dir, manifestPath: "nope/REVIEW.md", requesterSessionId: "watcher-2" })
    expect(notified).toHaveLength(1)
  })
})

describe("attestation composition (Goal B)", () => {
  /** main (base) ← feature, grown by one commit at a time. Each `grow()`
   *  call adds a commit and returns the new head. */
  async function growingRepo(review: string) {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "agp-review-compose-")))
    sh(dir, "init", "-q", "-b", "main")
    sh(dir, "config", "user.email", "t@example.com")
    sh(dir, "config", "user.name", "t")
    sh(dir, "config", "commit.gpgsign", "false")
    await writeFile(join(dir, "REVIEW.md"), review)
    await mkdir(join(dir, "rubrics"))
    await writeFile(join(dir, "rubrics", "correctness.md"), RUBRIC)
    await writeFile(join(dir, "a.txt"), "a\n")
    sh(dir, "add", "-A")
    sh(dir, "commit", "-qm", "base")
    const baseSha = sh(dir, "rev-parse", "HEAD")
    sh(dir, "checkout", "-qb", "feature")
    sh(dir, "remote", "add", "origin", "git@github.com:acme/demo.git")
    let n = 0
    const grow = async (): Promise<string> => {
      n += 1
      await writeFile(join(dir, `f${n}.txt`), `${n}\n`)
      sh(dir, "add", "-A")
      sh(dir, "commit", "-qm", `change ${n}`)
      return sh(dir, "rev-parse", "HEAD")
    }
    return { dir, baseSha, grow }
  }

  const COMPOSE_REVIEW = manifest([
    '{id: files, kind: command, run: "true"}',
    "{id: correctness, kind: agent, preset: kimi, rubric: ./rubrics/correctness.md}",
  ])

  it("reuses a prior passing attestation: the agent lane reviews only the delta, composedFrom is set, the command lane still runs at the new head", async () => {
    const repo = await growingRepo(COMPOSE_REVIEW)
    cleanup.push(repo.dir)
    const { host, calls } = fakeReviewers({ findings: [] })
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }), reviewers: host })

    const mid = await repo.grow()
    const first = await runToEnd(runner, { cwd: repo.dir, base: repo.baseSha, head: mid })
    expect(first.attestation!.verdict).toBe("pass")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.prompt).toContain(`${repo.baseSha}..${mid}`)

    const head = await repo.grow()
    const second = await runToEnd(runner, { cwd: repo.dir, base: repo.baseSha, head })
    expect(second.attestation!.verdict).toBe("pass")
    expect(second.cached).toBeUndefined() // grew past the cached rangeSha — a real run, not a ledger hit
    expect(calls).toHaveLength(2)

    // The agent lane's prompt only names the delta range, and says so.
    expect(calls[1]!.prompt).toContain(`${mid}..${head}`)
    expect(calls[1]!.prompt).not.toContain(`${repo.baseSha}..${head}`)
    expect(calls[1]!.prompt).toMatch(/DELTA re-review/)
    expect(calls[1]!.prompt).toContain(mid)

    const correctness = second.attestation!.lanes.find((l) => l.id === "correctness")!
    expect(correctness.composedFrom).toMatchObject({ headSha: mid, rangeSha: rangeSha({ baseSha: repo.baseSha, headSha: mid }) })
    expect(correctness.composedFrom!.attestationSha256).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/))

    // Command lanes are never composed — always the full frozen range.
    const files = second.attestation!.lanes.find((l) => l.id === "files")!
    expect(files.composedFrom).toBeUndefined()
    expect(second.attestation!.target).toEqual({ repoRemote: "github.com/acme/demo", baseSha: repo.baseSha, headSha: head })
  })

  it("does not compose when the rubric changed in between — full review, no composedFrom", async () => {
    const repo = await growingRepo(COMPOSE_REVIEW)
    cleanup.push(repo.dir)
    const { host, calls } = fakeReviewers({ findings: [] })
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }), reviewers: host })

    const mid = await repo.grow()
    await runToEnd(runner, { cwd: repo.dir, base: repo.baseSha, head: mid })
    await writeFile(join(repo.dir, "rubrics", "correctness.md"), `${RUBRIC}\nEdited.\n`)
    sh(repo.dir, "add", "-A")
    sh(repo.dir, "commit", "-qm", "edit rubric")
    const head = await repo.grow()

    const second = await runToEnd(runner, { cwd: repo.dir, base: repo.baseSha, head })
    expect(calls[1]!.prompt).toContain(`${repo.baseSha}..${head}`)
    expect(calls[1]!.prompt).not.toMatch(/DELTA re-review/)
    expect(second.attestation!.lanes.find((l) => l.id === "correctness")!.composedFrom).toBeUndefined()
  })

  it("does not compose across a different binding, a different base, a non-ancestor head, or onto an attestation that didn't itself pass", async () => {
    const repo = await growingRepo(
      manifest(
        [
          '{id: files, kind: command, run: "true"}',
          "{id: correctness, kind: agent, preset: kimi, rubric: ./rubrics/correctness.md}",
        ],
        ["a:", "  checks: [files, correctness]", "b:", "  checks: [files, correctness]"],
      ),
    )
    cleanup.push(repo.dir)
    const { host, calls } = fakeReviewers({ findings: [] })
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }), reviewers: host })

    const mid = await repo.grow()
    await runToEnd(runner, { cwd: repo.dir, binding: "a", base: repo.baseSha, head: mid })
    const head = await repo.grow()

    // Different binding: no candidate.
    const otherBinding = await runToEnd(runner, { cwd: repo.dir, binding: "b", base: repo.baseSha, head })
    expect(calls.at(-1)!.prompt).toContain(`${repo.baseSha}..${head}`)
    expect(otherBinding.attestation!.lanes.find((l) => l.id === "correctness")!.composedFrom).toBeUndefined()

    // Different base: the prior attestation's baseSha (repo.baseSha) doesn't
    // match this run's base (mid) — no candidate, even though mid..head is
    // otherwise a perfectly good delta.
    const differentBase = await runToEnd(runner, { cwd: repo.dir, binding: "a", base: mid, head })
    expect(differentBase.attestation!.lanes.find((l) => l.id === "correctness")!.composedFrom).toBeUndefined()

    // A branch that does NOT contain `mid` (not an ancestor): no candidate.
    sh(repo.dir, "checkout", "-qb", "sibling", repo.baseSha)
    await writeFile(join(repo.dir, "sibling.txt"), "s\n")
    sh(repo.dir, "add", "-A")
    sh(repo.dir, "commit", "-qm", "sibling change")
    const siblingHead = sh(repo.dir, "rev-parse", "HEAD")
    const sibling = await runToEnd(runner, { cwd: repo.dir, binding: "a", base: repo.baseSha, head: siblingHead })
    expect(sibling.attestation!.lanes.find((l) => l.id === "correctness")!.composedFrom).toBeUndefined()
  })

  it("does not compose onto a prior attestation whose OVERALL verdict wasn't pass — even for a lane that itself passed", async () => {
    const repo = await growingRepo(
      manifest([
        '{id: files, kind: command, run: "false"}', // always fails ⇒ verdict block
        "{id: correctness, kind: agent, preset: kimi, rubric: ./rubrics/correctness.md}",
      ]),
    )
    cleanup.push(repo.dir)
    const { host, calls } = fakeReviewers({ findings: [] }) // correctness itself always passes
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }), reviewers: host })

    const mid = await repo.grow()
    const first = await runToEnd(runner, { cwd: repo.dir, base: repo.baseSha, head: mid })
    expect(first.attestation!.verdict).toBe("block")
    expect(first.attestation!.lanes.find((l) => l.id === "correctness")!.status).toBe("pass")

    const head = await repo.grow()
    const second = await runToEnd(runner, { cwd: repo.dir, base: repo.baseSha, head })
    expect(calls.at(-1)!.prompt).toContain(`${repo.baseSha}..${head}`)
    expect(second.attestation!.lanes.find((l) => l.id === "correctness")!.composedFrom).toBeUndefined()
  })

  it("nocache implies compose:false; compose:false always reviews the full range", async () => {
    const repo = await growingRepo(COMPOSE_REVIEW)
    cleanup.push(repo.dir)
    const { host, calls } = fakeReviewers({ findings: [] })
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }), reviewers: host })

    const mid = await repo.grow()
    await runToEnd(runner, { cwd: repo.dir, base: repo.baseSha, head: mid })
    const head = await repo.grow()

    const withCompose = await runToEnd(runner, { cwd: repo.dir, base: repo.baseSha, head, compose: false })
    expect(calls.at(-1)!.prompt).toContain(`${repo.baseSha}..${head}`)
    expect(withCompose.attestation!.lanes.find((l) => l.id === "correctness")!.composedFrom).toBeUndefined()
  })
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find((c) => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

async function connect(runner: ReviewRunner) {
  const server = new McpServer({ name: "review-tools-test-server", version: "0.0.0" })
  registerReviewTools(server, { runner, callerSessionId: "caller-1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "review-tools-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

describe("review MCP tools", () => {
  it("review_run → review_ledger → review_export round-trips a verifiable attestation", async () => {
    const review = manifest(
      ['{id: files, kind: command, run: "test -f b.txt"}', "{id: correctness, kind: agent, preset: kimi, rubric: ./rubrics/correctness.md}"],
      undefined,
      ["verdict: {exportDir: .reviews}"],
    )
    const repo = await makeRepo(review)
    cleanup.push(repo.dir)
    const { host, calls } = fakeReviewers({ findings: [] })
    const client = await connect(createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }), reviewers: host }))

    const ran = parseToolJson(await client.callTool({ name: "review_run", arguments: { cwd: repo.dir } }))
    expect(ran).toMatchObject({ status: "done", verdict: "pass", reviewId: "demo", binding: "default" })
    expect(calls[0]!.parentSessionId).toBe("caller-1")
    expect(ran.attestation.requester).toEqual({ sessionId: "caller-1", gitAuthor: { name: "t", email: "t@example.com" } })

    const status = parseToolJson(await client.callTool({ name: "review_status", arguments: { runId: ran.runId } }))
    expect(status).toMatchObject({ runId: ran.runId, status: "done", verdict: "pass" })

    const ledger = parseToolJson(
      await client.callTool({ name: "review_ledger", arguments: { cwd: repo.dir, range: "main..feature" } }),
    )
    expect(ledger.total).toBe(1)
    expect(ledger.attestations[0]).toMatchObject({
      runId: ran.runId,
      verdict: "pass",
      repoRemote: "github.com/acme/demo",
      baseSha: repo.baseSha,
      headSha: repo.headSha,
    })
    const byRangeSha = parseToolJson(
      await client.callTool({ name: "review_ledger", arguments: { range: ledger.attestations[0].rangeSha } }),
    )
    expect(byRangeSha.total).toBe(1)

    const outPath = join(repo.dir, "..", `${ran.runId}.json`)
    cleanup.push(outPath)
    const exported = parseToolJson(await client.callTool({ name: "review_export", arguments: { runId: ran.runId, outPath } }))
    expect(exported).toEqual({ path: outPath, runId: ran.runId, verdict: "pass" })
    const att = JSON.parse(await readFile(outPath, "utf8")) as Attestation
    expect(
      verifyAttestation(att, {
        manifestSource: review,
        baseSha: repo.baseSha,
        headSha: repo.headSha,
        repoRemote: "github.com/acme/demo",
        verdict: "pass",
      }),
    ).toEqual({ ok: true, problems: [] })

    // No outPath → the manifest's verdict.exportDir, by repoRemote + rangeSha.
    const byKey = parseToolJson(
      await client.callTool({
        name: "review_export",
        arguments: { repoRemote: "github.com/acme/demo", rangeSha: att.rangeSha },
      }),
    )
    expect(byKey.path).toBe(join(repo.dir, ".reviews", `demo-default-${repo.headSha.slice(0, 12)}.json`))
  })

  it("review_run records a pr passthrough; review_ledger rows show it", async () => {
    const repo = await makeRepo(manifest(['{id: ok, kind: command, run: "true"}']))
    cleanup.push(repo.dir)
    const client = await connect(createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) }))
    const pr = { provider: "github", repo: "acme/demo", number: 9, url: "https://github.com/acme/demo/pull/9" }
    const ran = parseToolJson(
      await client.callTool({ name: "review_run", arguments: { cwd: repo.dir, pr, requesterSessionId: "gate" } }),
    )
    expect(ran.attestation.pr).toEqual(pr)
    expect(ran.attestation.requester.sessionId).toBe("gate")
    const rows = parseToolJson(await client.callTool({ name: "review_ledger", arguments: { cwd: repo.dir } }))
    expect(rows.attestations[0]).toMatchObject({ runId: ran.runId, pr, requester: { sessionId: "gate" } })

    const bad = await client.callTool({
      name: "review_run",
      arguments: { cwd: repo.dir, pr: { provider: "gitlab", repo: "x", number: 1, url: "nope" } },
    })
    expect(bad.isError).toBe(true)
  })

  it("review_run wait:false returns a runId to poll", async () => {
    const repo = await makeRepo(manifest(['{id: ok, kind: command, run: "sleep 0.2"}']))
    cleanup.push(repo.dir)
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) })
    const client = await connect(runner)
    const started = parseToolJson(await client.callTool({ name: "review_run", arguments: { cwd: repo.dir, wait: false } }))
    expect(started).toEqual({ runId: expect.stringMatching(/^review-/), status: "running" })
    await runner.wait(started.runId)
    const polled = parseToolJson(await client.callTool({ name: "review_status", arguments: { runId: started.runId } }))
    expect(polled).toMatchObject({ status: "done", verdict: "pass" })
  })

  it("review_ledger includeRunning: a running row (lanes settled so far) precedes the settled row", async () => {
    const repo = await makeRepo(
      manifest(['{id: fast, kind: command, run: "true"}', '{id: slow, kind: command, run: "sleep 2"}']),
    )
    cleanup.push(repo.dir)
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) })
    const client = await connect(runner)
    const started = parseToolJson(await client.callTool({ name: "review_run", arguments: { cwd: repo.dir, wait: false } }))

    const until = Date.now() + 5000
    while ((await runner.status(started.runId))?.lanes.length !== 1) {
      if (Date.now() > until) throw new Error("timed out waiting for the fast lane to settle")
      await new Promise((r) => setTimeout(r, 25))
    }
    const whileRunning = parseToolJson(
      await client.callTool({ name: "review_ledger", arguments: { cwd: repo.dir, includeRunning: true } }),
    )
    const runningRow = whileRunning.attestations.find((r: { runId: string }) => r.runId === started.runId)
    expect(runningRow).toMatchObject({ runId: started.runId, status: "running" })
    expect(runningRow.lanes.some((l: { id: string; status: string }) => l.id === "fast" && l.status === "pass")).toBe(true)
    expect(runningRow.verdict).toBeUndefined()

    await runner.wait(started.runId)
    const afterDone = parseToolJson(
      await client.callTool({ name: "review_ledger", arguments: { cwd: repo.dir, includeRunning: true } }),
    )
    const settledRow = afterDone.attestations.find((r: { runId: string }) => r.runId === started.runId)
    expect(settledRow).toMatchObject({ runId: started.runId, verdict: "pass" })
    expect(settledRow.status).toBeUndefined()
    expect(afterDone.attestations.filter((r: { runId: string }) => r.runId === started.runId)).toHaveLength(1)
  })

  it("review_ledger requesterSessionId scopes to that session; subtree includes a child's", async () => {
    // Three SEPARATE repos (distinct ranges) so each requester owns its own
    // ledger entry — a single shared range re-reviewed by a different
    // requester (an overwrite of the same ledger key) is covered below.
    // `makeRepo` hardcodes the SAME origin remote for every call, and a
    // fast/quiet runner can create all three within the same wall-clock
    // second — with identical content, message, and author that makes the
    // `feature` commit (and therefore rangeSha) BYTE-IDENTICAL across all
    // three repos, silently collapsing them onto one ledger key. An extra
    // unique marker file per repo keeps the tree (hence the commit hash)
    // distinct regardless of timing.
    const repoA = await makeRepo(manifest(['{id: ok, kind: command, run: "true"}']))
    const repoB = await makeRepo(manifest(['{id: ok, kind: command, run: "true"}']))
    const repoC = await makeRepo(manifest(['{id: ok, kind: command, run: "true"}']))
    cleanup.push(repoA.dir, repoB.dir, repoC.dir)
    for (const [repo, marker] of [[repoA, "A"], [repoB, "B"], [repoC, "C"]] as const) {
      await writeFile(join(repo.dir, "marker.txt"), marker)
      sh(repo.dir, "add", "-A")
      sh(repo.dir, "commit", "-qm", `marker ${marker}`)
    }
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) })
    const server = new McpServer({ name: "review-tools-test-server", version: "0.0.0" })
    registerReviewTools(server, {
      runner,
      resolveSubtree: (id) => (id === "parent-x" ? ["parent-x", "child-y"] : [id]),
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "review-tools-test-client", version: "0.0.0" })
    await client.connect(clientTransport)

    await runToEnd(runner, { cwd: repoA.dir, requesterSessionId: "parent-x" })
    await runToEnd(runner, { cwd: repoB.dir, requesterSessionId: "child-y" })
    await runToEnd(runner, { cwd: repoC.dir, requesterSessionId: "unrelated-z" })

    const parentOnly = parseToolJson(
      await client.callTool({ name: "review_ledger", arguments: { requesterSessionId: "parent-x" } }),
    )
    expect(parentOnly.total).toBe(1)
    expect(parentOnly.attestations[0].requester).toMatchObject({ sessionId: "parent-x" })

    const withSubtree = parseToolJson(
      await client.callTool({ name: "review_ledger", arguments: { requesterSessionId: "parent-x", subtree: true } }),
    )
    expect(withSubtree.total).toBe(2)
    expect(withSubtree.attestations.map((a: { requester: { sessionId: string } }) => a.requester.sessionId).sort()).toEqual([
      "child-y",
      "parent-x",
    ])
  })

  it("re-reviewing the exact same range under a different requester drops the old requester's stale index entry", async () => {
    // Ledger identity is (repoRemote, manifestSha, binding, rangeSha) — a
    // `nocache` re-run of the SAME range overwrites the one entry that key
    // has. requesterSessionId filtering must follow the overwrite, not keep
    // pointing the old requester at a file that no longer names them.
    const repo = await makeRepo(manifest(['{id: ok, kind: command, run: "true"}']))
    cleanup.push(repo.dir)
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) })
    await runToEnd(runner, { cwd: repo.dir, requesterSessionId: "first-requester" })
    await runToEnd(runner, { cwd: repo.dir, requesterSessionId: "second-requester", nocache: true })

    expect(await runner.ledger.list({ requesterSessionIds: ["second-requester"] })).toHaveLength(1)
    expect(await runner.ledger.list({ requesterSessionIds: ["first-requester"] })).toEqual([])
  })

  it("error shapes: unknown run, export without a selector, bad range", async () => {
    const client = await connect(createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) }))
    const unknown = await client.callTool({ name: "review_status", arguments: { runId: "review-nope" } })
    expect(unknown.isError).toBe(true)
    expect(parseToolJson(unknown)).toEqual({ error: "review run 'review-nope' not found" })

    const noSel = await client.callTool({ name: "review_export", arguments: {} })
    expect(noSel.isError).toBe(true)
    expect(parseToolJson(noSel).error).toMatch(/pass `runId`, or `repoRemote` \+ `rangeSha`/)

    const badRange = await client.callTool({ name: "review_ledger", arguments: { range: "main..feature" } })
    expect(badRange.isError).toBe(true)
    expect(parseToolJson(badRange).error).toMatch(/refs in `range` need `cwd`/)
  })
})
