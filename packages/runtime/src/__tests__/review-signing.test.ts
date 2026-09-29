/**
 * review-signing.ts — the daemon-side "only the daemon signs" mechanism
 * (Goal A, `.plans/review-primitive/PLAN-step1.6-signing.md`): key
 * generation, `ssh-keygen -Y sign`/`-Y verify` round-trips against a real
 * temp key, tamper detection, and the unsigned fallback when `ssh-keygen`
 * is unavailable.
 */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { buildAttestation, manifestSha, type Attestation, type LaneResult } from "@agentproto/review"
import {
  allowedSignersLine,
  ensureReviewSigningKey,
  resolvePrincipal,
  signAttestation,
  verifySignedAttestation,
} from "../review-signing.js"

const cleanup: string[] = []
afterEach(async () => {
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true })
})

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

const TARGET = { repoRemote: "github.com/acme/repo", baseSha: "a".repeat(40), headSha: "c".repeat(40) }
const lanes: LaneResult[] = [{ id: "ok", kind: "command", status: "pass", blocking: true, findings: [], durationMs: 1 }]

function attestation(over: Partial<Parameters<typeof buildAttestation>[0]> = {}): Attestation {
  return buildAttestation({
    runId: "run-1",
    reviewId: "demo",
    manifestSha: manifestSha("---\nkind: review\n---\n"),
    binding: "ci",
    target: TARGET,
    lanes,
    attestor: { daemon: "host", presets: [] },
    createdAt: "2026-09-25T00:00:00.000Z",
    ...over,
  })
}

describe("ensureReviewSigningKey", () => {
  it("generates a 0600 keypair on first use, and reuses it on the next call", async () => {
    const dir = await tmp("agp-review-keys-")
    const first = await ensureReviewSigningKey({ dir })
    expect(first.fingerprint).toMatch(/^SHA256:/)
    expect(first.publicKeyLine).toMatch(/^ssh-ed25519 /)
    const mode = (await stat(first.privateKeyPath)).mode & 0o777
    expect(mode).toBe(0o600)

    const second = await ensureReviewSigningKey({ dir })
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(second.privateKeyPath).toBe(first.privateKeyPath)
  })
})

describe("allowedSignersLine", () => {
  it("formats <principal> namespaces=\"agentproto-review\" <algo> <key>", async () => {
    const dir = await tmp("agp-review-keys-")
    const key = await ensureReviewSigningKey({ dir })
    const line = allowedSignersLine("me@example.com", key.publicKeyLine)
    expect(line).toBe(`me@example.com namespaces="agentproto-review" ${key.publicKeyLine.split(/\s+/).slice(0, 2).join(" ")}`)
  })
})

describe("resolvePrincipal", () => {
  it("prefers an explicit configuredPrincipal over git config", async () => {
    const dir = await tmp("agp-review-repo-")
    expect(await resolvePrincipal({ repoRoot: dir, configuredPrincipal: "pinned@example.com" })).toBe("pinned@example.com")
  })

  it("falls back to git config user.email of the repo", async () => {
    const { execFileSync } = await import("node:child_process")
    const dir = await tmp("agp-review-repo-")
    execFileSync("git", ["init", "-q"], { cwd: dir })
    execFileSync("git", ["config", "user.email", "repo@example.com"], { cwd: dir })
    expect(await resolvePrincipal({ repoRoot: dir })).toBe("repo@example.com")
  })

  it("falls back to a host-derived value when git has no configured email", async () => {
    const dir = await tmp("agp-review-not-a-repo-")
    const p = await resolvePrincipal({ repoRoot: dir })
    expect(p).toMatch(/^agentproto-review@/)
  })
})

describe("sign / verify round-trip", () => {
  it("signs and verifies against an allowed_signers file naming the principal", async () => {
    const dir = await tmp("agp-review-keys-")
    const att = attestation()
    const signed = await signAttestation(att, { principal: "me@example.com", keysDir: dir })
    expect(signed.error).toBeUndefined()
    expect(signed.signature).toMatchObject({ alg: "ssh-ed25519", principal: "me@example.com" })
    expect(signed.signature!.sig).toContain("BEGIN SSH SIGNATURE")

    const key = await ensureReviewSigningKey({ dir })
    const allowedSignersPath = join(dir, "allowed_signers")
    await writeFile(allowedSignersPath, `${allowedSignersLine("me@example.com", key.publicKeyLine)}\n`)

    const signedAtt: Attestation = { ...att, attestor: { ...att.attestor, signature: signed.signature } }
    const result = await verifySignedAttestation(signedAtt, { allowedSignersPath })
    expect(result).toEqual({ ok: true, problems: [] })
  })

  it("rejects a missing signature", async () => {
    const result = await verifySignedAttestation(attestation(), { allowedSignersPath: "/nonexistent" })
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual(["attestation is not signed"])
  })

  it("rejects when the allowed_signers file does not exist", async () => {
    const dir = await tmp("agp-review-keys-")
    const att = attestation()
    const signed = await signAttestation(att, { principal: "me@example.com", keysDir: dir })
    const signedAtt: Attestation = { ...att, attestor: { ...att.attestor, signature: signed.signature } }
    const result = await verifySignedAttestation(signedAtt, { allowedSignersPath: join(dir, "no-such-file") })
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toMatch(/allowed_signers file not found/)
  })

  it("exit-6-shaped: an allowed_signers file that does not list the signing key", async () => {
    const dir = await tmp("agp-review-keys-")
    const att = attestation()
    const signed = await signAttestation(att, { principal: "me@example.com", keysDir: dir })
    const signedAtt: Attestation = { ...att, attestor: { ...att.attestor, signature: signed.signature } }

    // A DIFFERENT key's allowed_signers — the real signing key isn't in it.
    const otherDir = await tmp("agp-review-other-key-")
    const otherKey = await ensureReviewSigningKey({ dir: otherDir })
    const allowedSignersPath = join(dir, "allowed_signers")
    await writeFile(allowedSignersPath, `${allowedSignersLine("me@example.com", otherKey.publicKeyLine)}\n`)

    const result = await verifySignedAttestation(signedAtt, { allowedSignersPath })
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toMatch(/no principal 'me@example\.com' maps to the signing key/)
  })

  describe("tamper detection — flip one field at a time after signing", () => {
    async function setup() {
      const dir = await tmp("agp-review-keys-")
      const att = attestation()
      const signed = await signAttestation(att, { principal: "me@example.com", keysDir: dir })
      const key = await ensureReviewSigningKey({ dir })
      const allowedSignersPath = join(dir, "allowed_signers")
      await writeFile(allowedSignersPath, `${allowedSignersLine("me@example.com", key.publicKeyLine)}\n`)
      const signedAtt: Attestation = { ...att, attestor: { ...att.attestor, signature: signed.signature } }
      return { signedAtt, allowedSignersPath }
    }

    it("flips the verdict", async () => {
      const { signedAtt, allowedSignersPath } = await setup()
      const tampered: Attestation = { ...signedAtt, verdict: "block" }
      expect((await verifySignedAttestation(tampered, { allowedSignersPath })).ok).toBe(false)
    })

    it("flips a lane's status", async () => {
      const { signedAtt, allowedSignersPath } = await setup()
      const tampered: Attestation = { ...signedAtt, lanes: [{ ...signedAtt.lanes[0]!, status: "fail" }] }
      expect((await verifySignedAttestation(tampered, { allowedSignersPath })).ok).toBe(false)
    })

    it("swaps the claimed principal", async () => {
      const { signedAtt, allowedSignersPath } = await setup()
      const tampered: Attestation = {
        ...signedAtt,
        attestor: { ...signedAtt.attestor, signature: { ...signedAtt.attestor.signature!, principal: "attacker@evil.com" } },
      }
      const result = await verifySignedAttestation(tampered, { allowedSignersPath })
      expect(result.ok).toBe(false)
    })
  })
})

describe("unsigned fallback — ssh-keygen unavailable", () => {
  it("signAttestation never throws; it resolves { error } and the caller can write the attestation unsigned", async () => {
    const dir = await tmp("agp-review-keys-")
    const emptyBinDir = await tmp("agp-empty-path-")
    const result = await signAttestation(attestation(), {
      principal: "me@example.com",
      keysDir: dir,
      env: { PATH: emptyBinDir },
    })
    expect(result.signature).toBeUndefined()
    expect(result.error).toBeTruthy()
    expect(result.error).toMatch(/ssh-keygen/)
  })

  it("verifySignedAttestation also degrades to a problem rather than throwing", async () => {
    const dir = await tmp("agp-review-keys-")
    const att = attestation()
    const signed = await signAttestation(att, { principal: "me@example.com", keysDir: dir })
    const signedAtt: Attestation = { ...att, attestor: { ...att.attestor, signature: signed.signature } }
    const allowedSignersPath = join(dir, "allowed_signers")
    await writeFile(allowedSignersPath, "me@example.com namespaces=\"agentproto-review\" ssh-ed25519 AAAA\n")
    const emptyBinDir = await tmp("agp-empty-path-")
    const result = await verifySignedAttestation(signedAtt, { allowedSignersPath, env: { PATH: emptyBinDir } })
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toMatch(/ssh-keygen is not available/)
  })
})
