import { describe, it, expect } from "vitest"
import {
  ATTESTATION_SCHEMA,
  buildAttestation,
  ledgerKeyOf,
  manifestSha,
  rangeSha,
  sha256Hex,
  verifyAttestation,
  type LaneResult,
} from "../index.js"

const SOURCE = "---\nkind: review\n---\n"
const TARGET = { repoRemote: "github.com/acme/repo", baseSha: "a".repeat(40), headSha: "c".repeat(40) }

const lanes = (status: LaneResult["status"]): LaneResult[] => [
  { id: "types", kind: "command", status, blocking: true, findings: [], durationMs: 10 },
  { id: "lint", kind: "command", status: "fail", blocking: false, findings: [], durationMs: 5 },
]

const build = (status: LaneResult["status"] = "pass") =>
  buildAttestation({
    runId: "run-1",
    reviewId: "demo",
    manifestSha: manifestSha(SOURCE),
    binding: "ci",
    target: TARGET,
    lanes: lanes(status),
    attestor: { daemon: "host:18790", presets: ["kimi", "kimi"] },
    createdAt: "2026-09-25T00:00:00.000Z",
  })

describe("buildAttestation", () => {
  it("derives the verdict from its lanes and binds the range", () => {
    const att = build()
    expect(att).toMatchObject({
      schema: ATTESTATION_SCHEMA,
      verdict: "pass",
      rangeSha: sha256Hex(`${"a".repeat(40)}..${"c".repeat(40)}`),
      attestor: { daemon: "host:18790", presets: ["kimi"] },
      rubrics: [],
    })
    expect(att.dirty).toBeUndefined()
    expect(build("fail").verdict).toBe("block")
    expect(build("timeout").verdict).toBe("incomplete")
  })

  it("keys the ledger on (repoRemote, manifestSha, binding, rangeSha)", () => {
    expect(ledgerKeyOf(build())).toEqual({
      repoRemote: TARGET.repoRemote,
      manifestSha: manifestSha(SOURCE),
      binding: "ci",
      rangeSha: rangeSha(TARGET),
    })
  })
})

describe("verifyAttestation", () => {
  it("accepts an attestation matching the verifier's manifest + range", () => {
    expect(
      verifyAttestation(build(), {
        manifestSource: SOURCE,
        baseSha: TARGET.baseSha,
        headSha: TARGET.headSha,
        repoRemote: TARGET.repoRemote,
        binding: "ci",
        verdict: "pass",
      }),
    ).toEqual({ ok: true, problems: [] })
  })

  it("rejects a manifest or range mismatch", () => {
    const r = verifyAttestation(build(), { manifestSource: SOURCE + "edited", headSha: "d".repeat(40) })
    expect(r.ok).toBe(false)
    expect(r.problems).toEqual(["manifestSha mismatch", "headSha mismatch"])
  })

  it("catches a hand-edited verdict or target", () => {
    const tampered = { ...build("fail"), verdict: "pass" as const }
    expect(verifyAttestation(tampered).problems).toContain(
      "verdict 'pass' does not follow from its lanes (expected 'block')",
    )
    const moved = { ...build(), target: { ...TARGET, headSha: "e".repeat(40) } }
    expect(verifyAttestation(moved).problems).toContain("rangeSha does not match target.baseSha..target.headSha")
  })

  it("rejects a dirty-tree attestation and an unmet verdict requirement", () => {
    const dirty = buildAttestation({ ...build(), attestor: build().attestor, dirty: true, lanes: lanes("timeout") })
    const r = verifyAttestation(dirty, { verdict: "pass" })
    expect(r.problems).toEqual([
      "verdict is 'incomplete', expected 'pass'",
      "attestation was produced from a dirty working tree",
    ])
  })
})
