/**
 * `agentproto review` — init (scratch git repos in tmpdir: idempotence,
 * hook chaining, core.hooksPath, husky, the hook actually gating a push
 * through a fake `agentproto` on PATH), verify (exported attestations
 * against a real range), and the trinary verdict rendering.
 */

import { execFileSync, spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  attestationSha256,
  buildAttestation,
  manifestSha,
  parseReviewManifest,
  rangeSha,
  resolvePacks,
  type Attestation,
  type LaneResult,
} from "@agentproto/review"
import { createReviewPackLoader } from "@agentproto/runtime"
import { BLOCK_START, HOOK_SCRIPT, defaultPackNamespace, reviewInit } from "../commands/review-init.js"
import { EXIT, VERIFY_EXIT, prRefFromUrl, renderVerdict, runReview } from "../commands/review.js"

vi.setConfig({ testTimeout: 30_000 })

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

const cleanup: string[] = []
afterEach(async () => {
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true })
})

async function scratchRepo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "agp-review-init-")))
  cleanup.push(dir)
  sh(dir, "init", "-q", "-b", "main")
  sh(dir, "config", "user.email", "t@example.com")
  sh(dir, "config", "user.name", "t")
  sh(dir, "config", "commit.gpgsign", "false")
  await writeFile(join(dir, "a.txt"), "a\n")
  sh(dir, "add", "-A")
  sh(dir, "commit", "-qm", "base")
  return dir
}

const isExec = async (p: string) => ((await stat(p)).mode & 0o111) !== 0

describe("review init", () => {
  it("scaffolds REVIEW.md + hook; a second run is a no-op", async () => {
    const repo = await scratchRepo()
    const first = await reviewInit({ cwd: repo })
    expect(first.noop).toBe(false)
    expect(first.steps.map((s) => s.action)).toEqual(["created", "created", "created"])

    const review = await readFile(join(repo, "REVIEW.md"), "utf8")
    expect(review).toMatch(/^kind: review$/m)
    expect(review).toMatch(/local:\n\s+on: pre-push\n\s+checks: \[tests\]/)
    expect(review).toMatch(/# - id: correctness\n\s+#\s+kind: agent/)
    // It parses: the scaffold is a valid manifest.
    const { parseReviewManifest } = await import("@agentproto/review")
    const m = parseReviewManifest(review)
    expect(Object.keys(m.bindings)).toEqual(["local"])
    expect(m.checks[0]).toMatchObject({ id: "tests", kind: "command", run: "git diff --check {base} HEAD" })

    const hooks = join(repo, ".git", "hooks")
    expect(await readFile(join(hooks, "pre-push"), "utf8")).toContain(BLOCK_START)
    expect(await isExec(join(hooks, "pre-push"))).toBe(true)
    expect(await isExec(join(hooks, HOOK_SCRIPT))).toBe(true)

    const second = await reviewInit({ cwd: repo })
    expect(second.noop).toBe(true)
    expect(second.steps.every((s) => s.action === "unchanged")).toBe(true)
    expect(await readFile(join(repo, "REVIEW.md"), "utf8")).toBe(review)
  })

  it("uses `<pm> test` when package.json declares a test script", async () => {
    const repo = await scratchRepo()
    await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }))
    await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
    await reviewInit({ cwd: repo })
    expect(await readFile(join(repo, "REVIEW.md"), "utf8")).toContain('run: "pnpm test"')
  })

  it("chains after an existing pre-push hook — original preserved, runs first", async () => {
    const repo = await scratchRepo()
    const hookPath = join(repo, ".git", "hooks", "pre-push")
    const original = '#!/bin/sh\necho "original ran" >> "$HOOK_LOG"\n'
    await writeFile(hookPath, original)
    await chmod(hookPath, 0o755)

    const res = await reviewInit({ cwd: repo })
    expect(res.steps.find((s) => s.path === hookPath)).toMatchObject({ action: "chained" })
    const chained = await readFile(hookPath, "utf8")
    expect(chained.startsWith(original)).toBe(true)
    expect(chained).toContain(BLOCK_START)

    // Idempotent: the block is never appended twice.
    const again = await reviewInit({ cwd: repo })
    expect(again.noop).toBe(true)
    expect(await readFile(hookPath, "utf8")).toBe(chained)
  })

  it("leaves a non-shell pre-push alone and says how to chain it", async () => {
    const repo = await scratchRepo()
    const hookPath = join(repo, ".git", "hooks", "pre-push")
    const py = "#!/usr/bin/env python3\nprint('hi')\n"
    await writeFile(hookPath, py)
    const res = await reviewInit({ cwd: repo })
    expect(res.steps.find((s) => s.path === hookPath)).toMatchObject({ action: "skipped" })
    expect(await readFile(hookPath, "utf8")).toBe(py)
  })

  it("respects core.hooksPath (and husky's .husky/_ indirection)", async () => {
    const repo = await scratchRepo()
    sh(repo, "config", "core.hooksPath", ".githooks")
    await reviewInit({ cwd: repo })
    expect(await readFile(join(repo, ".githooks", "pre-push"), "utf8")).toContain(BLOCK_START)

    const husky = await scratchRepo()
    await mkdir(join(husky, ".husky", "_"), { recursive: true })
    sh(husky, "config", "core.hooksPath", ".husky/_")
    await reviewInit({ cwd: husky })
    expect(await readFile(join(husky, ".husky", "pre-push"), "utf8")).toContain(BLOCK_START)
  })

  it("--ci github writes the Actions shim (idempotently) and a ci binding", async () => {
    const repo = await scratchRepo()
    const first = await reviewInit({ cwd: repo, ci: "github" })
    const wfPath = join(repo, ".github", "workflows", "review.yml")
    expect(first.steps.find((s) => s.path === wfPath)).toMatchObject({ action: "created" })
    const wf = await readFile(wfPath, "utf8")
    expect(wf).toContain("review run --headless --binding ci --annotate github")
    expect(wf).toContain("review verify --if-exported --annotate github")
    expect(wf).toContain("::error title=review incomplete::")
    expect(await readFile(join(repo, "REVIEW.md"), "utf8")).toMatch(/ci:\n\s+on: pull_request/)
    expect((await reviewInit({ cwd: repo, ci: "github" })).noop).toBe(true)
  })

  it("--ci github passes --allowed-signers only when .agentproto/allowed_signers already exists", async () => {
    const withoutFile = await scratchRepo()
    await reviewInit({ cwd: withoutFile, ci: "github" })
    const wfWithout = await readFile(join(withoutFile, ".github", "workflows", "review.yml"), "utf8")
    expect(wfWithout).not.toContain("--allowed-signers")

    const withFile = await scratchRepo()
    await mkdir(join(withFile, ".agentproto"), { recursive: true })
    await writeFile(join(withFile, ".agentproto", "allowed_signers"), "me@example.com namespaces=\"agentproto-review\" ssh-ed25519 AAAA\n")
    await reviewInit({ cwd: withFile, ci: "github" })
    const wfWith = await readFile(join(withFile, ".github", "workflows", "review.yml"), "utf8")
    expect(wfWith).toContain("review verify --if-exported --annotate github --allowed-signers .agentproto/allowed_signers")
  })

  it("the installed hook gates a real push on the CLI's exit code", async () => {
    const repo = await scratchRepo()
    const remote = await realpath(await mkdtemp(join(tmpdir(), "agp-review-remote-")))
    cleanup.push(remote)
    sh(remote, "init", "-q", "--bare")
    sh(repo, "remote", "add", "origin", remote)
    sh(repo, "push", "-q", "origin", "main")
    const hookPath = join(repo, ".git", "hooks", "pre-push")
    await writeFile(hookPath, '#!/bin/sh\necho "original ran" >> "$HOOK_LOG"\n')
    await chmod(hookPath, 0o755)
    await reviewInit({ cwd: repo })

    // Fake `agentproto`: records its argv, exits $FAKE_EXIT.
    const bin = await mkdtemp(join(tmpdir(), "agp-fake-agentproto-"))
    cleanup.push(bin)
    const log = join(bin, "log")
    await writeFile(join(bin, "agentproto"), `#!/bin/sh\necho "agentproto $*" >> "${log}"\nexit \${FAKE_EXIT:-0}\n`)
    await chmod(join(bin, "agentproto"), 0o755)

    await writeFile(join(repo, "b.txt"), "b\n")
    sh(repo, "add", "-A")
    sh(repo, "commit", "-qm", "change")
    const push = (code: number) =>
      spawnSync("git", ["push", "-q", "origin", "HEAD:refs/heads/feature"], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_EXIT: String(code), HOOK_LOG: log },
      })

    const blocked = push(EXIT.block)
    expect(blocked.status).not.toBe(0)
    const incomplete = push(EXIT.incomplete)
    expect(incomplete.status).not.toBe(0)
    const passed = push(EXIT.pass)
    expect(passed.status).toBe(0)
    expect(sh(remote, "rev-parse", "feature")).toBe(sh(repo, "rev-parse", "HEAD"))

    const calls = (await readFile(log, "utf8")).trim().split("\n")
    // Each push: the original hook first, then the review gate.
    expect(calls.filter((l) => l === "original ran")).toHaveLength(3)
    const gate = calls.filter((l) => l.startsWith("agentproto "))
    expect(gate).toHaveLength(3)
    // origin/HEAD isn't set in this scratch remote ⇒ the manifest's base applies.
    expect(gate[0]).toBe("agentproto review run --binding local --supersede")
  })

  it("--pack scaffolds REVIEW.md AND adds a uses[] entry in one write; a second --pack with the same ref is a no-op", async () => {
    const repo = await scratchRepo()
    const first = await reviewInit({ cwd: repo, pack: "@agentproto/review-pack-core" })
    expect(first.noop).toBe(false)
    expect(first.steps.find((s) => s.path.endsWith("REVIEW.md"))).toMatchObject({ action: "created" })

    const review = await readFile(join(repo, "REVIEW.md"), "utf8")
    const { parseReviewManifest } = await import("@agentproto/review")
    const m = parseReviewManifest(review)
    expect(m.uses).toEqual([{ pack: "@agentproto/review-pack-core", as: "core", overrides: {}, allowCommands: false }])

    const second = await reviewInit({ cwd: repo, pack: "@agentproto/review-pack-core" })
    expect(second.steps.find((s) => s.path.endsWith("REVIEW.md"))).toMatchObject({ action: "unchanged" })
    expect(await readFile(join(repo, "REVIEW.md"), "utf8")).toBe(review)

    // A different --as for the SAME ref is still a no-op (idempotent by ref).
    const third = await reviewInit({ cwd: repo, pack: "@agentproto/review-pack-core", packAs: "other" })
    expect(third.steps.find((s) => s.path.endsWith("REVIEW.md"))).toMatchObject({ action: "unchanged" })
  })

  it("--pack on an EXISTING REVIEW.md adds a uses[] entry, preserving the file's comments", async () => {
    const repo = await scratchRepo()
    await reviewInit({ cwd: repo }) // scaffold first, no --pack
    const before = await readFile(join(repo, "REVIEW.md"), "utf8")
    expect(before).toContain("# An agent reviewer lane")

    const res = await reviewInit({ cwd: repo, pack: "./packs/core", packAs: "core" })
    expect(res.steps.find((s) => s.path.endsWith("REVIEW.md"))).toMatchObject({ action: "updated" })
    const after = await readFile(join(repo, "REVIEW.md"), "utf8")
    expect(after).toContain("# An agent reviewer lane") // comment survived — no full re-serialization
    const { parseReviewManifest } = await import("@agentproto/review")
    expect(parseReviewManifest(after).uses).toEqual([{ pack: "./packs/core", as: "core", overrides: {}, allowCommands: false }])
  })
})

describe("defaultPackNamespace", () => {
  it("derives a slug from an npm name, a relative path, or a pinned git ref", () => {
    expect(defaultPackNamespace("@agentproto/review-pack-core")).toBe("core")
    expect(defaultPackNamespace("./packs/security-extra")).toBe("security-extra")
    expect(defaultPackNamespace(`git+https://example.com/org/review-pack-foo.git#${"a".repeat(40)}`)).toBe("foo")
  })
})

// ── verify ───────────────────────────────────────────────────────────

const MANIFEST = [
  "---",
  "kind: review",
  "id: demo",
  "target: {kind: git-range, base: main}",
  "checks:",
  '  - {id: ok, kind: command, run: "true"}',
  "verdict: {exportDir: .reviews}",
  "---",
  "",
].join("\n")

async function verifyRepo(): Promise<{ dir: string; baseSha: string; headSha: string }> {
  const dir = await scratchRepo()
  await writeFile(join(dir, "REVIEW.md"), MANIFEST)
  sh(dir, "add", "-A")
  sh(dir, "commit", "-qm", "review")
  const baseSha = sh(dir, "rev-parse", "HEAD")
  sh(dir, "checkout", "-qb", "feature")
  await writeFile(join(dir, "b.txt"), "b\n")
  sh(dir, "add", "-A")
  sh(dir, "commit", "-qm", "change")
  sh(dir, "remote", "add", "origin", "git@github.com:acme/demo.git")
  return { dir, baseSha, headSha: sh(dir, "rev-parse", "HEAD") }
}

const passLanes: LaneResult[] = [{ id: "ok", kind: "command", status: "pass", blocking: true, findings: [], durationMs: 1 }]

function attest(baseSha: string, headSha: string, over: Partial<Parameters<typeof buildAttestation>[0]> = {}): Attestation {
  return buildAttestation({
    runId: "run-1",
    reviewId: "demo",
    manifestSha: manifestSha(MANIFEST),
    binding: "local",
    target: { repoRemote: "github.com/acme/demo", baseSha, headSha },
    lanes: passLanes,
    attestor: { daemon: "d", presets: [] },
    ...over,
  })
}

async function captureRun(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ""
  let err = ""
  const o = vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
    out += String(c)
    return true
  })
  const e = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
    err += String(c)
    return true
  })
  try {
    const code = await runReview(args)
    return { code, out, err }
  } finally {
    o.mockRestore()
    e.mockRestore()
  }
}

describe("review verify", () => {
  it("verifies the exported attestation for the range; rejects a tampered one", async () => {
    const repo = await verifyRepo()
    await mkdir(join(repo.dir, ".reviews"))
    const att = attest(repo.baseSha, repo.headSha)
    await writeFile(join(repo.dir, ".reviews", "demo-local.json"), JSON.stringify(att))
    const ok = await captureRun(["verify", "--cwd", repo.dir, "--json"])
    expect(ok.code).toBe(0)
    expect(JSON.parse(ok.out)).toMatchObject({ ok: true, runId: "run-1", verdict: "pass" })

    await writeFile(join(repo.dir, ".reviews", "demo-local.json"), JSON.stringify({ ...att, verdict: "pass", lanes: [{ ...passLanes[0], status: "fail" }] }))
    const bad = await captureRun(["verify", "--cwd", repo.dir, "--annotate", "github"])
    expect(bad.code).toBe(1)
    expect(bad.err).toMatch(/does NOT verify/)
    expect(bad.err).toMatch(/::error title=review attestation invalid::/)
  })

  it("resolves a composedFrom reference in the export dir; a missing or tampered prior fails it (exit 1)", async () => {
    const repo = await verifyRepo()
    await writeFile(join(repo.dir, "c.txt"), "c\n")
    sh(repo.dir, "add", "-A")
    sh(repo.dir, "commit", "-qm", "second change")
    const head = sh(repo.dir, "rev-parse", "HEAD")

    const prior = attest(repo.baseSha, repo.headSha, { runId: "run-prior" })
    const current = attest(repo.baseSha, head, {
      runId: "run-current",
      lanes: [
        {
          ...passLanes[0]!,
          composedFrom: { rangeSha: rangeSha({ baseSha: repo.baseSha, headSha: repo.headSha }), headSha: repo.headSha, attestationSha256: attestationSha256(prior) },
        },
      ],
    })
    await mkdir(join(repo.dir, ".reviews"))
    await writeFile(join(repo.dir, ".reviews", "demo-local-prior.json"), JSON.stringify(prior))
    await writeFile(join(repo.dir, ".reviews", "demo-local-current.json"), JSON.stringify(current))

    const ok = await captureRun(["verify", "--cwd", repo.dir, "--json"])
    expect(ok.code).toBe(VERIFY_EXIT.ok)

    // The prior attestation changes after the fact (its digest no longer
    // matches composedFrom.attestationSha256) — the reference no longer
    // resolves, even though `current`'s own content still verifies fine.
    await writeFile(join(repo.dir, ".reviews", "demo-local-prior.json"), JSON.stringify({ ...prior, verdict: "pass", lanes: [{ ...passLanes[0], status: "fail" }] }))
    const tampered = await captureRun(["verify", "--cwd", repo.dir, "--json"])
    expect(tampered.code).toBe(VERIFY_EXIT.invalid)
    expect(JSON.parse(tampered.out).problems[0]).toMatch(/does not match composedFrom.attestationSha256/)

    // Removing the prior entirely: the reference doesn't resolve at all.
    await rm(join(repo.dir, ".reviews", "demo-local-prior.json"))
    const missing = await captureRun(["verify", "--cwd", repo.dir, "--json"])
    expect(missing.code).toBe(VERIFY_EXIT.invalid)
    expect(JSON.parse(missing.out).problems[0]).toMatch(/not found in/)
  })

  it("accepts HEAD^ when HEAD only commits the export; 4 when nothing matches; 5 with --if-exported and no exportDir", async () => {
    const repo = await verifyRepo()
    await mkdir(join(repo.dir, ".reviews"))
    await writeFile(join(repo.dir, ".reviews", "demo-local.json"), JSON.stringify(attest(repo.baseSha, repo.headSha)))
    sh(repo.dir, "add", "-A")
    sh(repo.dir, "commit", "-qm", "export attestation")
    expect((await captureRun(["verify", "--cwd", repo.dir])).code).toBe(0)

    await writeFile(join(repo.dir, "c.txt"), "c\n")
    sh(repo.dir, "add", "-A")
    sh(repo.dir, "commit", "-qm", "more code")
    const missing = await captureRun(["verify", "--cwd", repo.dir, "--annotate", "github"])
    expect(missing.code).toBe(4)
    expect(missing.err).toMatch(/::error title=review attestation missing::/)

    await writeFile(join(repo.dir, "REVIEW.md"), MANIFEST.replace("verdict: {exportDir: .reviews}\n", ""))
    expect((await captureRun(["verify", "--cwd", repo.dir, "--if-exported"])).code).toBe(5)
  })

  describe("review pack digests", () => {
    const PACK_MANIFEST = [
      "---",
      "kind: review",
      "id: demo",
      "target: {kind: git-range, base: main}",
      "uses:",
      "  - {pack: ./packs/core, as: core}",
      "checks:",
      '  - {id: ok, kind: command, run: "true"}',
      "bindings:",
      "  local: {checks: [ok, core/lint]}",
      "verdict: {exportDir: .reviews}",
      "---",
      "",
    ].join("\n")

    async function packRepo(): Promise<{ dir: string; baseSha: string; headSha: string }> {
      const dir = await scratchRepo()
      await writeFile(join(dir, "REVIEW.md"), PACK_MANIFEST)
      await mkdir(join(dir, "packs", "core"), { recursive: true })
      await writeFile(
        join(dir, "packs", "core", "REVIEW.md"),
        ["---", "kind: review-pack", "id: core", "version: 1.0.0", "checks:", "  - {id: lint, kind: command, run: echo lint}", "---", ""].join("\n"),
      )
      sh(dir, "add", "-A")
      sh(dir, "commit", "-qm", "review + pack")
      const baseSha = sh(dir, "rev-parse", "HEAD")
      sh(dir, "checkout", "-qb", "feature")
      await writeFile(join(dir, "b.txt"), "b\n")
      sh(dir, "add", "-A")
      sh(dir, "commit", "-qm", "change")
      sh(dir, "remote", "add", "origin", "git@github.com:acme/demo.git")
      return { dir, baseSha, headSha: sh(dir, "rev-parse", "HEAD") }
    }

    async function realPackDigest(dir: string) {
      const manifest = parseReviewManifest(PACK_MANIFEST)
      const loader = createReviewPackLoader({ repoRoot: dir, manifestDir: dir })
      return (await resolvePacks(manifest, loader)).packs[0]!
    }

    it("passes when the attestation's pack digest matches what this checkout resolves right now", async () => {
      const repo = await packRepo()
      await mkdir(join(repo.dir, ".reviews"))
      const pack = await realPackDigest(repo.dir)
      const att = attest(repo.baseSha, repo.headSha, { manifestSha: manifestSha(PACK_MANIFEST), packs: [pack] })
      await writeFile(join(repo.dir, ".reviews", "demo-local.json"), JSON.stringify(att))
      const ok = await captureRun(["verify", "--cwd", repo.dir, "--json"])
      expect(ok.code).toBe(0)
      expect(JSON.parse(ok.out)).toMatchObject({ ok: true })
    })

    it("fails when the attestation's pack digest does not match what this checkout resolves now", async () => {
      const repo = await packRepo()
      await mkdir(join(repo.dir, ".reviews"))
      const pack = await realPackDigest(repo.dir)
      const att = attest(repo.baseSha, repo.headSha, {
        manifestSha: manifestSha(PACK_MANIFEST),
        packs: [{ ...pack, sha256: "0".repeat(64) }],
      })
      await writeFile(join(repo.dir, ".reviews", "demo-local.json"), JSON.stringify(att))
      const bad = await captureRun(["verify", "--cwd", repo.dir, "--json"])
      expect(bad.code).toBe(VERIFY_EXIT.invalid)
      expect(JSON.parse(bad.out).problems[0]).toMatch(/pack '.\/packs\/core' content changed/)
    })

    it("reports (but does not fail on) a pack this checkout can't resolve", async () => {
      const repo = await packRepo()
      await mkdir(join(repo.dir, ".reviews"))
      const att = attest(repo.baseSha, repo.headSha, {
        manifestSha: manifestSha(PACK_MANIFEST),
        packs: [{ ref: "./packs/core", id: "core", version: "1.0.0", sha256: "1".repeat(64) }],
      })
      await writeFile(join(repo.dir, ".reviews", "demo-local.json"), JSON.stringify(att))
      // Delete the pack directory so it can no longer resolve.
      await rm(join(repo.dir, "packs"), { recursive: true, force: true })
      const result = await captureRun(["verify", "--cwd", repo.dir, "--json"])
      expect(result.code).toBe(0)
      expect(JSON.parse(result.out).packNotes[0]).toMatch(/not resolvable/)
    })
  })
})

describe("review run", () => {
  it("an unreachable daemon is `incomplete` (exit 2) with the trinary message — never a pass", async () => {
    const repo = await verifyRepo()
    const prev = process.env.AGENTPROTO_DAEMON_URL
    process.env.AGENTPROTO_DAEMON_URL = "http://127.0.0.1:9" // discard port: nothing listens
    try {
      const res = await captureRun(["run", "--cwd", repo.dir, "--binding", "local"])
      expect(res.code).toBe(EXIT.incomplete)
      expect(res.err).toMatch(/review INCOMPLETE — the daemon is not reachable/)
      expect(res.err).toMatch(/incomplete ≠ rejection — daemon\/lane failed, fix and retry/)
    } finally {
      if (prev === undefined) delete process.env.AGENTPROTO_DAEMON_URL
      else process.env.AGENTPROTO_DAEMON_URL = prev
    }
  })
})

// ── rendering ────────────────────────────────────────────────────────

describe("renderVerdict", () => {
  const target = { repoRemote: "github.com/acme/demo", baseSha: "a".repeat(40), headSha: "b".repeat(40) }
  const make = (lanes: LaneResult[]) =>
    buildAttestation({ runId: "r", reviewId: "demo", manifestSha: "m", binding: "local", target, lanes, attestor: { daemon: "d", presets: [] } })

  it("maps pass / block / incomplete / could-not-run onto distinct exit codes and messages", () => {
    expect(renderVerdict({ status: "done", attestation: make(passLanes) }).code).toBe(EXIT.pass)

    const blocked = renderVerdict(
      {
        status: "done",
        attestation: make([
          { id: "ok", kind: "command", status: "fail", blocking: true, durationMs: 1, findings: [{ severity: "high", title: "boom", detail: "x", file: "a.ts", line: 3 }] },
        ]),
      },
      { annotate: "github" },
    )
    expect(blocked.code).toBe(EXIT.block)
    expect(blocked.lines.join("\n")).toMatch(/blocked by: ok/)
    expect(blocked.lines.join("\n")).toMatch(/::error file=a.ts,line=3,title=/)

    const incomplete = renderVerdict(
      {
        status: "done",
        attestation: make([
          ...passLanes,
          { id: "correctness", kind: "agent", status: "skipped", blocking: true, durationMs: 0, findings: [], error: "agent lanes are not available" },
        ]),
      },
      { annotate: "github" },
    )
    expect(incomplete.code).toBe(EXIT.incomplete)
    const text = incomplete.lines.join("\n")
    expect(text).toMatch(/incomplete ≠ rejection — daemon\/lane failed, fix and retry/)
    expect(text).toMatch(/::warning title=review incomplete::/)
    expect(text).not.toMatch(/::error/)

    expect(renderVerdict({ status: "failed", error: "no REVIEW.md" }).code).toBe(EXIT.error)
    const superseded = renderVerdict({ runId: "r1", status: "cancelled", supersededBy: "r2" })
    expect(superseded.lines[0]).toMatch(/superseded by r2/)
  })

  it("parses a --pr url into the attestation's pr shape", () => {
    expect(prRefFromUrl("https://github.com/acme/demo/pull/12")).toEqual({
      provider: "github",
      repo: "acme/demo",
      number: 12,
      url: "https://github.com/acme/demo/pull/12",
    })
    expect(prRefFromUrl("https://gitlab.com/x/y/-/merge_requests/1")).toBeUndefined()
  })
})
