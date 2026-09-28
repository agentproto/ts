/**
 * `findComposeCandidate`'s pack-digest eligibility rule (Step 5): a lane
 * whose check came from a `uses[]` pack composes only onto a prior
 * attestation that carries an IDENTICAL digest for that pack — not just a
 * matching rubric digest for the lane's own check. Isolated unit tests
 * against a fake ledger; the full attestation-composition flow (rubric-only
 * rules) is exercised end-to-end in review-runner.test.ts.
 */

import { execFileSync } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ATTESTATION_SCHEMA, PACK_DIGEST_ALG, type Attestation } from "@agentproto/review"
import { findComposeCandidate, type FindComposeCandidateInput } from "../review-compose.js"
import type { LedgerEntry, ReviewLedger } from "../review-ledger.js"

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

let repoRoot: string
let priorHeadSha: string
let newHeadSha: string
const cleanup: string[] = []

beforeEach(async () => {
  repoRoot = await realpath(await mkdtemp(join(tmpdir(), "agp-compose-")))
  cleanup.push(repoRoot)
  sh(repoRoot, "init", "-q", "-b", "main")
  sh(repoRoot, "config", "user.email", "t@example.com")
  sh(repoRoot, "config", "user.name", "t")
  sh(repoRoot, "config", "commit.gpgsign", "false")
  sh(repoRoot, "commit", "-q", "--allow-empty", "-m", "base")
  priorHeadSha = sh(repoRoot, "rev-parse", "HEAD")
  sh(repoRoot, "commit", "-q", "--allow-empty", "-m", "next")
  newHeadSha = sh(repoRoot, "rev-parse", "HEAD")
})
afterEach(async () => {
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true })
})

function fakeAttestation(overrides: Partial<Attestation> = {}): Attestation {
  return {
    schema: ATTESTATION_SCHEMA,
    runId: "run-1",
    reviewId: "demo",
    manifestSha: "manifest-sha",
    binding: "local",
    target: { repoRemote: "local:demo", baseSha: "base-sha", headSha: priorHeadSha },
    rangeSha: "range-sha",
    lanes: [{ id: "core/correctness", kind: "agent", status: "pass", blocking: true, findings: [], durationMs: 1 }],
    verdict: "pass",
    attestor: { daemon: "d", presets: [] },
    rubrics: [{ check: "core/correctness", path: "./rubrics/correctness.md", sha256: "rubric-sha" }],
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function fakeLedger(entries: Attestation[]): ReviewLedger {
  const notImplemented = () => {
    throw new Error("not implemented in this fake")
  }
  return {
    root: "/fake",
    put: notImplemented,
    get: notImplemented,
    lookupCached: notImplemented,
    findByRunId: notImplemented,
    async list() {
      return entries.map((attestation): LedgerEntry => ({ attestation, host: { repoRoot, manifestPath: "REVIEW.md" } }))
    },
    getAnnotations: notImplemented,
    updateAnnotations: notImplemented,
  }
}

const baseInput = (ledger: ReviewLedger): FindComposeCandidateInput => ({
  ledger,
  repoRoot,
  repoRemote: "local:demo",
  manifestSha: "manifest-sha",
  binding: "local",
  checkId: "core/correctness",
  rubricSha256: "rubric-sha",
  baseSha: "base-sha",
  headSha: newHeadSha,
})

describe("findComposeCandidate — pack digest rule", () => {
  it("composes when no packDigest is required (a local, non-pack check)", async () => {
    const ledger = fakeLedger([fakeAttestation()])
    const candidate = await findComposeCandidate({ ...baseInput(ledger), checkId: "core/correctness" })
    expect(candidate?.attestation.target.headSha).toBe(priorHeadSha)
  })

  it("composes when the prior attestation carries an identical pack digest", async () => {
    const ledger = fakeLedger([fakeAttestation({ packs: [{ ref: "./core-pack", id: "core", version: "1.0.0", alg: PACK_DIGEST_ALG, sha256: "pack-sha-1" }] })])
    const candidate = await findComposeCandidate({
      ...baseInput(ledger),
      packDigest: { id: "core", sha256: "pack-sha-1" },
    })
    expect(candidate).toBeDefined()
  })

  it("rejects composition when the pack digest differs — even though the rubric digest alone still matches", async () => {
    // Same rubric sha256 as baseInput's rubricSha256 ('rubric-sha'), but the
    // pack as a whole (e.g. another check's config, or the pack's own
    // REVIEW.md) changed — proves this rule catches something the existing
    // per-check rubric-digest check does not.
    const ledger = fakeLedger([fakeAttestation({ packs: [{ ref: "./core-pack", id: "core", version: "1.0.0", alg: PACK_DIGEST_ALG, sha256: "pack-sha-OLD" }] })])
    const candidate = await findComposeCandidate({
      ...baseInput(ledger),
      packDigest: { id: "core", sha256: "pack-sha-NEW" },
    })
    expect(candidate).toBeUndefined()
  })

  it("rejects composition when the prior attestation carries no packs field at all", async () => {
    const ledger = fakeLedger([fakeAttestation()])
    const candidate = await findComposeCandidate({
      ...baseInput(ledger),
      packDigest: { id: "core", sha256: "pack-sha-1" },
    })
    expect(candidate).toBeUndefined()
  })
})
