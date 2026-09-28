/**
 * review-runner.ts wired to a `uses[]` review pack, over a real temp git
 * repo: namespaced lanes run, the attestation records `packs`, a pack rubric
 * edit changes the digest and invalidates the cache (same range, clean
 * tree) exactly like a local rubric edit does, and an unresolvable preset
 * fails the run with an error naming the check.
 */

import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createReviewLedger } from "../review-ledger.js"
import { createReviewRunner, type ReviewerSessionHost, type ReviewRunner } from "../review-runner.js"

vi.setConfig({ testTimeout: 30_000 })

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

const CORE_RUBRIC = "# correctness\nFind bugs.\n"

function corePackSource(): string {
  return [
    "---",
    "kind: review-pack",
    "id: core",
    "version: 1.0.0",
    "checks:",
    "  - {id: correctness, kind: agent, rubric: ./rubrics/correctness.md, blockOn: high}",
    "---",
    "",
    "Core pack.",
  ].join("\n")
}

function consumerManifest(usesLines: string[]): string {
  return [
    "---",
    "kind: review",
    "id: demo",
    "target: {kind: git-range, base: main}",
    ...usesLines,
    "checks:",
    "  - {id: files, kind: command, run: \"test -f b.txt\"}",
    "bindings:",
    "  local: {checks: [files, core/correctness]}",
    "---",
    "",
    "Demo review with a pack.",
  ].join("\n")
}

async function makeRepo(review: string): Promise<{ dir: string; baseSha: string; headSha: string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "agp-review-pack-repo-")))
  sh(dir, "init", "-q", "-b", "main")
  sh(dir, "config", "user.email", "t@example.com")
  sh(dir, "config", "user.name", "t")
  sh(dir, "config", "commit.gpgsign", "false")
  await writeFile(join(dir, "REVIEW.md"), review)
  await mkdir(join(dir, "packs", "core", "rubrics"), { recursive: true })
  await writeFile(join(dir, "packs", "core", "REVIEW.md"), corePackSource())
  await writeFile(join(dir, "packs", "core", "rubrics", "correctness.md"), CORE_RUBRIC)
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

function fakeReviewers(report: unknown) {
  const calls: Array<{ preset: string; prompt: string }> = []
  const host: ReviewerSessionHost = {
    async run(input) {
      calls.push(input)
      const path = input.prompt.match(/write EXACTLY ONE file — (\S+) —/)?.[1]
      if (!path) throw new Error("prompt names no verdict path")
      await writeFile(path, JSON.stringify(report))
      return { status: "ended", sessionId: `sess-${calls.length}`, preset: input.preset }
    },
  }
  return { host, calls }
}

let ledgerRoot: string
const cleanup: string[] = []

beforeEach(async () => {
  ledgerRoot = await mkdtemp(join(tmpdir(), "agp-review-pack-ledger-"))
  cleanup.push(ledgerRoot)
})
afterEach(async () => {
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true })
})

async function runToEnd(runner: ReviewRunner, input: Parameters<ReviewRunner["start"]>[0]) {
  const run = runner.start(input)
  return (await runner.wait(run.runId))!
}

describe("review runner — uses[] review packs", () => {
  it("runs the namespaced pack lane and records a pack digest on the attestation", async () => {
    const repo = await makeRepo(consumerManifest(["uses:", "  - {pack: ./packs/core, as: core, preset: kimi}"]))
    cleanup.push(repo.dir)
    const { host, calls } = fakeReviewers({ decision: "approve", summary: "fine", findings: [] })
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }), reviewers: host })

    const run = await runToEnd(runner, { cwd: repo.dir })
    expect(run.status).toBe("done")
    const att = run.attestation!
    expect(att.verdict).toBe("pass")
    expect(att.lanes.map((l) => l.id)).toEqual(["files", "core/correctness"])
    expect(att.packs).toEqual([
      { ref: "./packs/core", id: "core", version: "1.0.0", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.preset).toBe("kimi")
    expect(calls[0]!.prompt).toContain(join(repo.dir, "packs", "core", "rubrics", "correctness.md"))
  })

  it("serves a cache hit for the same range, then a cache miss once the pack rubric changes", async () => {
    const repo = await makeRepo(consumerManifest(["uses:", "  - {pack: ./packs/core, as: core, preset: kimi}"]))
    cleanup.push(repo.dir)
    const { host, calls } = fakeReviewers({ findings: [] })
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }), reviewers: host })

    const first = await runToEnd(runner, { cwd: repo.dir })
    const firstDigest = first.attestation!.packs![0]!.sha256

    const second = await runToEnd(runner, { cwd: repo.dir })
    expect(second.cached).toBe(true)
    expect(calls).toHaveLength(1)

    // The rubric is outside the frozen range's tracked content the SAME way
    // a local rubric edit is (review-runner.test.ts's "a rubric edit
    // invalidates" case) — only the pack digest tells the runs apart.
    await writeFile(join(repo.dir, "packs", "core", "rubrics", "correctness.md"), `${CORE_RUBRIC}Also check perf.\n`)
    const third = await runToEnd(runner, { cwd: repo.dir })
    expect(third.cached).toBeUndefined()
    expect(third.attestation!.packs![0]!.sha256).not.toBe(firstDigest)
    expect(calls).toHaveLength(2)
  })

  it("fails the run, naming the check, when a pack's agent check resolves no preset anywhere", async () => {
    const repo = await makeRepo(consumerManifest(["uses:", "  - {pack: ./packs/core, as: core}"]))
    cleanup.push(repo.dir)
    const runner = createReviewRunner({ ledger: createReviewLedger({ root: ledgerRoot }) })
    const run = await runToEnd(runner, { cwd: repo.dir })
    expect(run.status).toBe("failed")
    expect(run.error).toMatch(/agent check 'correctness' has no preset/)
  })
})
