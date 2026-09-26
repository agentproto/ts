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
import { verifyAttestation, type Attestation } from "@agentproto/review"
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

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

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
    expect(att.attestor).toEqual({ daemon: "test-daemon", presets: ["kimi"] })
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
    expect(done.attestation!.verdict).toBe("incomplete")
    expect(done.attestation!.lanes[0]).toMatchObject({ status: "skipped" })
    expect(runner.cancel(run.runId)).toBe(false)
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
