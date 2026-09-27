/**
 * `review_pr` + the ledger's annotations sidecar, against a real temp git repo
 * and a FAKE `gh` put first on PATH (a shell script answering the handful of
 * `gh api` paths review-pr.ts calls) — the real `execGh` runner is exercised,
 * only the binary is fake.
 */

import { execFileSync } from "node:child_process"
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { ledgerKeyOf } from "@agentproto/review"
import { createReviewLedger, withPr, withPrStatus, type ReviewLedger } from "../review-ledger.js"
import { createReviewRunner, type ReviewRunner } from "../review-runner.js"
import { githubRepoOf, parsePrUrl } from "../review-pr.js"
import { registerReviewTools } from "../review-tools.js"

vi.setConfig({ testTimeout: 30_000 })

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

const REVIEW = [
  "---",
  "kind: review",
  "id: demo",
  "target: {kind: git-range, base: main}",
  "checks:",
  '  - {id: ok, kind: command, run: "true"}',
  "---",
  "",
].join("\n")

async function makeRepo(remote = "git@github.com:acme/demo.git"): Promise<{ dir: string; headSha: string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "agp-review-pr-repo-")))
  sh(dir, "init", "-q", "-b", "main")
  sh(dir, "config", "user.email", "t@example.com")
  sh(dir, "config", "user.name", "t")
  sh(dir, "config", "commit.gpgsign", "false")
  await writeFile(join(dir, "REVIEW.md"), REVIEW)
  sh(dir, "add", "-A")
  sh(dir, "commit", "-qm", "base")
  sh(dir, "checkout", "-qb", "feature")
  await writeFile(join(dir, "b.txt"), "b\n")
  sh(dir, "add", "-A")
  sh(dir, "commit", "-qm", "change")
  sh(dir, "remote", "add", "origin", remote)
  return { dir, headSha: sh(dir, "rev-parse", "HEAD") }
}

/** Install a fake `gh` in a fresh dir. `pulls` is the commits/{sha}/pulls
 *  answer; every call is appended to `<dir>/calls.log`. */
async function fakeGh(opts: { headSha: string; pulls: unknown[]; failChecks?: boolean }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agp-fake-gh-"))
  const pull = {
    number: 7,
    state: "closed",
    merged_at: "2026-09-02T00:00:00Z",
    html_url: "https://github.com/acme/demo/pull/7",
    head: { sha: opts.headSha },
  }
  await writeFile(join(dir, "pulls.json"), JSON.stringify(opts.pulls))
  await writeFile(join(dir, "pull.json"), JSON.stringify(pull))
  const script = `#!/bin/sh
for a; do p="$a"; done
echo "$*" >> "${dir}/calls.log"
case "$p" in
  repos/acme/demo/commits/*/pulls*) cat "${dir}/pulls.json" ;;
  repos/acme/demo/pulls/7/reviews*) echo '[{"user":{"login":"rev"},"state":"APPROVED","submitted_at":"2026-09-01T00:00:00Z"}]' ;;
  repos/acme/demo/pulls/7) cat "${dir}/pull.json" ;;
  repos/acme/demo/commits/*/check-runs*) ${opts.failChecks ? 'echo "rate limited" >&2; exit 1' : `echo '{"check_runs":[{"name":"ci","conclusion":"success"}]}'`} ;;
  *) echo "gh: unexpected path $p" >&2; exit 1 ;;
esac
`
  await writeFile(join(dir, "gh"), script)
  await chmod(join(dir, "gh"), 0o755)
  return dir
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find((c) => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

async function connect(runner: ReviewRunner) {
  const server = new McpServer({ name: "review-pr-test-server", version: "0.0.0" })
  registerReviewTools(server, { runner, callerSessionId: "caller-1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "review-pr-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

const ORIGINAL_PATH = process.env.PATH
let ledgerRoot: string
let ledger: ReviewLedger
const cleanup: string[] = []

beforeEach(async () => {
  ledgerRoot = await mkdtemp(join(tmpdir(), "agp-review-pr-ledger-"))
  ledger = createReviewLedger({ root: ledgerRoot })
  cleanup.push(ledgerRoot)
})
afterEach(async () => {
  process.env.PATH = ORIGINAL_PATH
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true })
})

/** `gh` resolves to the fake first; git etc. still resolve from the rest. */
const useGh = (dir: string) => {
  process.env.PATH = `${dir}:${ORIGINAL_PATH}`
}

async function reviewed(remote?: string) {
  const repo = await makeRepo(remote)
  cleanup.push(repo.dir)
  const runner = createReviewRunner({ ledger })
  const run = runner.start({ cwd: repo.dir })
  const done = (await runner.wait(run.runId))!
  expect(done.status).toBe("done")
  return { repo, runner, attestation: done.attestation! }
}

describe("helpers", () => {
  it("parse github remotes and PR urls", () => {
    expect(githubRepoOf("github.com/acme/demo")).toBe("acme/demo")
    expect(githubRepoOf("github.com-work/acme/demo")).toBe("acme/demo")
    expect(githubRepoOf("gitlab.com/acme/demo")).toBeUndefined()
    expect(githubRepoOf("local:/tmp/x")).toBeUndefined()
    expect(parsePrUrl("https://github.com/acme/demo/pull/7")).toEqual({ repo: "acme/demo", number: 7 })
    expect(parsePrUrl("https://github.com/acme/demo/pull/7/files?x=1")).toEqual({ repo: "acme/demo", number: 7 })
    expect(parsePrUrl("https://github.com/acme/demo/issues/7")).toBeUndefined()
  })
})

describe("ledger annotations sidecar", () => {
  it("reads {} when absent, appends snapshots in order, never touches the attestation", async () => {
    const { attestation } = await reviewed()
    const key = ledgerKeyOf(attestation)
    expect(await ledger.getAnnotations(key)).toEqual({})
    const pr = { provider: "github" as const, repo: "acme/demo", number: 7, url: "https://github.com/acme/demo/pull/7" }
    const snap = (at: string) => ({ fetchedAt: at, state: "open" as const, reviews: [] })
    // Concurrent appends on one key never lose a write.
    await Promise.all([
      ledger.updateAnnotations(key, withPr(pr)),
      ledger.updateAnnotations(key, withPrStatus(snap("1"))),
      ledger.updateAnnotations(key, withPrStatus(snap("2"))),
    ])
    const ann = await ledger.getAnnotations(key)
    expect(ann.pr).toEqual(pr)
    expect(ann.prStatus!.map((s) => s.fetchedAt)).toEqual(["1", "2"])
    const entries = await ledger.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.attestation).toEqual(attestation)
  })
})

describe("review_pr", () => {
  it("resolves headSha → PR via gh, writes the annotation, returns attestation + pr + status", async () => {
    const { repo, runner, attestation } = await reviewed()
    const ghDir = await fakeGh({
      headSha: repo.headSha,
      pulls: [{ number: 7, state: "closed", html_url: "https://github.com/acme/demo/pull/7", head: { sha: repo.headSha } }],
    })
    cleanup.push(ghDir)
    useGh(ghDir)
    const client = await connect(runner)

    const res = parseToolJson(await client.callTool({ name: "review_pr", arguments: { runId: attestation.runId } }))
    expect(res).toMatchObject({
      ok: true,
      linkedVia: "resolved",
      attestation: { runId: attestation.runId, verdict: "pass", headSha: repo.headSha },
      pr: { provider: "github", repo: "acme/demo", number: 7, url: "https://github.com/acme/demo/pull/7" },
      status: {
        state: "merged",
        reviews: [{ login: "rev", state: "APPROVED", submittedAt: "2026-09-01T00:00:00Z" }],
        checks: [{ name: "ci", conclusion: "success" }],
      },
      snapshots: 1,
    })
    const calls = await readFile(join(ghDir, "calls.log"), "utf8")
    expect(calls).toContain(`repos/acme/demo/commits/${repo.headSha}/pulls`)

    // Second call: the link comes from the annotation; one more snapshot.
    const again = parseToolJson(await client.callTool({ name: "review_pr", arguments: { cwd: repo.dir } }))
    expect(again).toMatchObject({ ok: true, linkedVia: "annotation", snapshots: 2 })
    const ann = await ledger.getAnnotations(ledgerKeyOf(attestation))
    expect(ann.prStatus).toHaveLength(2)

    // The ledger row now shows the PR.
    const rows = parseToolJson(await client.callTool({ name: "review_ledger", arguments: { cwd: repo.dir } }))
    expect(rows.attestations[0].pr).toMatchObject({ number: 7 })

    // prUrl selects the linked entry.
    const byUrl = parseToolJson(
      await client.callTool({ name: "review_pr", arguments: { prUrl: "https://github.com/acme/demo/pull/7" } }),
    )
    expect(byUrl).toMatchObject({ ok: true, attestation: { runId: attestation.runId } })
  })

  it("prUrl for an unlinked entry matches the PR's head sha", async () => {
    const { repo, runner, attestation } = await reviewed()
    const ghDir = await fakeGh({ headSha: repo.headSha, pulls: [], failChecks: true })
    cleanup.push(ghDir)
    useGh(ghDir)
    const client = await connect(runner)
    const res = parseToolJson(
      await client.callTool({ name: "review_pr", arguments: { prUrl: "https://github.com/acme/demo/pull/7" } }),
    )
    // Linked from the url itself; check runs failed ⇒ omitted, not fatal.
    expect(res).toMatchObject({ ok: true, linkedVia: "prUrl", attestation: { runId: attestation.runId } })
    expect(res.status.checks).toBeUndefined()
    expect((await ledger.getAnnotations(ledgerKeyOf(attestation))).pr).toMatchObject({ number: 7 })
  })

  it("no PR for the commit ⇒ soft `no_pr`, nothing written", async () => {
    const { repo, runner, attestation } = await reviewed()
    const ghDir = await fakeGh({ headSha: repo.headSha, pulls: [] })
    cleanup.push(ghDir)
    useGh(ghDir)
    const client = await connect(runner)
    const result = await client.callTool({ name: "review_pr", arguments: { runId: attestation.runId } })
    expect(result.isError).toBeFalsy()
    expect(parseToolJson(result)).toMatchObject({ ok: false, error: { code: "no_pr" }, attestation: { runId: attestation.runId } })
    expect(await ledger.getAnnotations(ledgerKeyOf(attestation))).toEqual({})
  })

  it("gh missing ⇒ soft `gh_unavailable` (the tool never throws)", async () => {
    const { runner, attestation } = await reviewed()
    const empty = await mkdtemp(join(tmpdir(), "agp-no-gh-"))
    cleanup.push(empty)
    process.env.PATH = empty
    const client = await connect(runner)
    const result = await client.callTool({ name: "review_pr", arguments: { runId: attestation.runId } })
    expect(result.isError).toBeFalsy()
    expect(parseToolJson(result)).toMatchObject({ ok: false, error: { code: "gh_unavailable" } })
  })

  it("gh failing (auth/network) ⇒ soft `gh_failed` carrying gh's stderr", async () => {
    const { runner, attestation } = await reviewed()
    const dir = await mkdtemp(join(tmpdir(), "agp-bad-gh-"))
    cleanup.push(dir)
    await writeFile(join(dir, "gh"), "#!/bin/sh\necho 'HTTP 401: Bad credentials' >&2\nexit 1\n")
    await chmod(join(dir, "gh"), 0o755)
    useGh(dir)
    const client = await connect(runner)
    const res = parseToolJson(await client.callTool({ name: "review_pr", arguments: { runId: attestation.runId } }))
    expect(res).toMatchObject({ ok: false, error: { code: "gh_failed" } })
    expect(res.error.message).toMatch(/Bad credentials/)
  })

  it("a non-GitHub remote ⇒ soft `unsupported_remote`; unknown selectors are errors", async () => {
    const { runner, attestation } = await reviewed("git@gitlab.com:acme/demo.git")
    const client = await connect(runner)
    const res = parseToolJson(await client.callTool({ name: "review_pr", arguments: { runId: attestation.runId } }))
    expect(res).toMatchObject({ ok: false, error: { code: "unsupported_remote" } })

    const none = await client.callTool({ name: "review_pr", arguments: {} })
    expect(none.isError).toBe(true)
    const unknown = await client.callTool({ name: "review_pr", arguments: { runId: "review-nope" } })
    expect(unknown.isError).toBe(true)
  })
})
