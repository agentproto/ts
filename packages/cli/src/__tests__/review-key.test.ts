/**
 * `agentproto review key` and `review verify --allowed-signers/--require-signed`
 * — signing surfaces on top of the review-signing.ts mechanism
 * (packages/runtime). `$HOME` is sandboxed per test (never the real
 * `~/.agentproto/keys` a developer machine or daemon actually uses).
 */

import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildAttestation, manifestSha, type Attestation, type LaneResult } from "@agentproto/review"
import { EXIT, VERIFY_EXIT, runReview } from "../commands/review.js"

vi.setConfig({ testTimeout: 30_000 })

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

let prevHome: string | undefined
let home: string
const cleanup: string[] = []

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-review-key-home-"))
  process.env.HOME = home
})
afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

async function scratchRepo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "agp-review-key-repo-")))
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

describe("review key", () => {
  it("generates the key on first use and prints fingerprint + allowed_signers line", async () => {
    const repo = await scratchRepo()
    const res = await captureRun(["key", "show", "--cwd", repo, "--json"])
    expect(res.code).toBe(0)
    const payload = JSON.parse(res.out)
    expect(payload.fingerprint).toMatch(/^SHA256:/)
    expect(payload.principal).toBe("t@example.com") // git config user.email of --cwd's repo
    expect(payload.allowedSignersLine).toBe(`t@example.com namespaces="agentproto-review" ${(await readFile(payload.publicKeyPath, "utf8")).trim().split(/\s+/).slice(0, 2).join(" ")}`)

    // Idempotent: a second call reuses the same key.
    const again = await captureRun(["key", "show", "--cwd", repo, "--json"])
    expect(JSON.parse(again.out).fingerprint).toBe(payload.fingerprint)
  })

  it("--principal overrides the claimed identity", async () => {
    const repo = await scratchRepo()
    const res = await captureRun(["key", "--cwd", repo, "--principal", "pinned@example.com", "--json"])
    expect(JSON.parse(res.out).principal).toBe("pinned@example.com")
  })
})

// ── verify --allowed-signers / --require-signed ────────────────────────

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

describe("review verify — signature", () => {
  it("passes --require-signed once the attestation is signed and its key is in allowed_signers", async () => {
    const repo = await verifyRepo()
    const key = await captureRun(["key", "show", "--cwd", repo.dir, "--json"])
    const { allowedSignersLine } = JSON.parse(key.out)

    const { signAttestation } = await import("@agentproto/runtime")
    const unsigned = attest(repo.baseSha, repo.headSha)
    const signed = await signAttestation(unsigned, { principal: "t@example.com" })
    expect(signed.error).toBeUndefined()
    const att = { ...unsigned, attestor: { daemon: "d", presets: [], signature: signed.signature } }

    await mkdir(join(repo.dir, ".reviews"))
    await writeFile(join(repo.dir, ".reviews", "demo-local.json"), JSON.stringify(att))
    await mkdir(join(repo.dir, ".agentproto"), { recursive: true })
    await writeFile(join(repo.dir, ".agentproto", "allowed_signers"), `${allowedSignersLine}\n`)

    const ok = await captureRun(["verify", "--cwd", repo.dir, "--require-signed", "--json"])
    expect(ok.code).toBe(EXIT.pass)
    expect(JSON.parse(ok.out)).toMatchObject({ ok: true, verdict: "pass" })
  })

  it("--require-signed with no signature is exit 6; without the flag an unsigned export still verifies (exit 0)", async () => {
    const repo = await verifyRepo()
    await mkdir(join(repo.dir, ".reviews"))
    await writeFile(join(repo.dir, ".reviews", "demo-local.json"), JSON.stringify(attest(repo.baseSha, repo.headSha)))

    const unsignedOk = await captureRun(["verify", "--cwd", repo.dir, "--json"])
    expect(unsignedOk.code).toBe(EXIT.pass)

    const required = await captureRun(["verify", "--cwd", repo.dir, "--require-signed", "--json"])
    expect(required.code).toBe(VERIFY_EXIT.signatureRequired)
    expect(JSON.parse(required.out).problems).toEqual(["attestation is not signed"])
  })

  it("an allowed_signers file that doesn't list the signing key is exit 6, even without --require-signed", async () => {
    const repo = await verifyRepo()
    const { signAttestation, ensureReviewSigningKey, allowedSignersLine } = await import("@agentproto/runtime")
    const unsigned = attest(repo.baseSha, repo.headSha)
    const signed = await signAttestation(unsigned, { principal: "t@example.com" })
    const att = { ...unsigned, attestor: { daemon: "d", presets: [], signature: signed.signature } }
    await mkdir(join(repo.dir, ".reviews"))
    await writeFile(join(repo.dir, ".reviews", "demo-local.json"), JSON.stringify(att))

    // A DIFFERENT key's allowed_signers line — not the one that actually signed.
    const otherDir = await mkdtemp(join(tmpdir(), "agp-review-key-other-"))
    cleanup.push(otherDir)
    const otherKey = await ensureReviewSigningKey({ dir: otherDir })
    await mkdir(join(repo.dir, ".agentproto"), { recursive: true })
    await writeFile(join(repo.dir, ".agentproto", "allowed_signers"), `${allowedSignersLine("t@example.com", otherKey.publicKeyLine)}\n`)

    const res = await captureRun(["verify", "--cwd", repo.dir, "--json"])
    expect(res.code).toBe(VERIFY_EXIT.signatureRequired)
    expect(JSON.parse(res.out).problems[0]).toMatch(/no principal 't@example\.com' maps to the signing key/)
  })

  it("a hand-edited verdict fails the content check first (exit 1), before any signature check runs", async () => {
    const repo = await verifyRepo()
    const att = attest(repo.baseSha, repo.headSha)
    const tampered = { ...att, verdict: "pass", lanes: [{ ...passLanes[0], status: "fail" }] }
    await mkdir(join(repo.dir, ".reviews"))
    await writeFile(join(repo.dir, ".reviews", "demo-local.json"), JSON.stringify(tampered))
    const res = await captureRun(["verify", "--cwd", repo.dir, "--require-signed", "--json"])
    expect(res.code).toBe(VERIFY_EXIT.invalid)
  })
})
