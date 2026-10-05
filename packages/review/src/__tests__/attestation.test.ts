import { describe, it, expect } from "vitest"
import {
  ATTESTATION_SCHEMA,
  attestationSha256,
  buildAttestation,
  canonicalAttestationBytes,
  canonicalJson,
  ledgerKeyOf,
  manifestSha,
  rangeSha,
  sha256Hex,
  toLaneResult,
  verifyAttestation,
  type Attestation,
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

describe("provenance fields (requester, pr, lane model)", () => {
  const PR = { provider: "github" as const, repo: "acme/repo", number: 42, url: "https://github.com/acme/repo/pull/42" }

  it("are optional: an attestation without them carries no empty keys", () => {
    const att = build()
    expect("requester" in att).toBe(false)
    expect("pr" in att).toBe(false)
    // An empty requester (no session, no author) is dropped, not recorded as {}.
    const empty = buildAttestation({
      runId: "r",
      reviewId: "demo",
      manifestSha: manifestSha(SOURCE),
      binding: "ci",
      target: TARGET,
      lanes: lanes("pass"),
      attestor: { daemon: "d", presets: [] },
      requester: {},
    })
    expect("requester" in empty).toBe(false)
  })

  it("round-trip through JSON and still verify (same schema version)", () => {
    const att = buildAttestation({
      runId: "run-1",
      reviewId: "demo",
      manifestSha: manifestSha(SOURCE),
      binding: "ci",
      target: TARGET,
      lanes: [
        {
          id: "correctness",
          kind: "agent",
          status: "pass",
          blocking: true,
          findings: [],
          durationMs: 9,
          sessionId: "s-1",
          preset: "kimi",
          model: "kimi-k2",
        },
      ],
      attestor: { daemon: "host", presets: ["kimi"] },
      requester: { sessionId: "caller-1", gitAuthor: { name: "Ada", email: "ada@example.com" } },
      pr: PR,
      createdAt: "2026-09-25T00:00:00.000Z",
    })
    const back = JSON.parse(JSON.stringify(att)) as Attestation
    expect(back).toEqual(att)
    expect(back.schema).toBe(ATTESTATION_SCHEMA)
    expect(back.requester).toEqual({ sessionId: "caller-1", gitAuthor: { name: "Ada", email: "ada@example.com" } })
    expect(back.pr).toEqual(PR)
    expect(back.lanes[0]!.model).toBe("kimi-k2")
    expect(verifyAttestation(back, { manifestSource: SOURCE, verdict: "pass" })).toEqual({ ok: true, problems: [] })
  })

  it("toLaneResult carries an agent lane's model through", () => {
    const check = {
      id: "correctness",
      kind: "agent" as const,
      preset: "kimi",
      fallbackPresets: [],
      rubric: "r.md",
      blockOn: "high" as const,
      blocking: true,
      timeoutMs: 1000,
      effects: false as const,
    }
    const r = toLaneResult(check, { outcome: "reported", report: { findings: [] }, sessionId: "s", preset: "kimi", model: "m-1" }, 1)
    expect(r).toMatchObject({ status: "pass", sessionId: "s", preset: "kimi", model: "m-1" })
    const skipped = toLaneResult(check, { outcome: "skipped", error: "x", preset: "kimi" }, 1)
    expect("model" in skipped).toBe(false)
  })
})

describe("canonicalAttestationBytes / attestationSha256", () => {
  it("strips attestor.signature but hashes everything else", () => {
    const att = build()
    const signed: Attestation = { ...att, attestor: { ...att.attestor, signature: { alg: "ssh-ed25519", keyFingerprint: "SHA256:x", principal: "p", signedAt: "t", sig: "s" } } }
    // The signed bytes are identical whether or not a signature is attached —
    // a verifier recomputes them the same way regardless.
    expect(canonicalAttestationBytes(signed)).toBe(canonicalAttestationBytes(att))
    expect(canonicalAttestationBytes(att)).toBe(canonicalJson(att))
    expect(canonicalAttestationBytes(att)).not.toMatch(/signature/)
  })

  it("attestationSha256 changes when the signature changes (it hashes the whole object)", () => {
    const att = build()
    const signed: Attestation = { ...att, attestor: { ...att.attestor, signature: { alg: "ssh-ed25519", keyFingerprint: "SHA256:x", principal: "p", signedAt: "t", sig: "s" } } }
    expect(attestationSha256(att)).not.toBe(attestationSha256(signed))
    expect(attestationSha256(att)).toBe(attestationSha256(build()))
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
