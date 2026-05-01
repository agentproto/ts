import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { recordAuditEvent } from "./audit-chain.js"
import { signArtifact } from "./sign-artifact.js"
import {
  addPendingSignatures,
  listPendingSignatures,
  removePendingSignature,
} from "./pending-signatures-index.js"
import type { GovernanceConfig } from "./workspace-config.js"
import { validateAuditLog } from "@agentproto/governance/validators"

/**
 * End-to-end test: spin a temp workspace, exercise the runtime helpers,
 * verify the produced files conform to the spec.
 */

const GENESIS = "0".repeat(64)
const SECRET = "e2e-test-secret"

let tmpRoot: string
let config: GovernanceConfig

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gov-e2e-"))
  config = {
    workspaceRoot: tmpRoot,
    genesisSeed: GENESIS,
    hmacSecret: SECRET,
  }
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

async function writeArtifact(relPath: string, content: string): Promise<void> {
  const abs = path.join(tmpRoot, relPath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, "utf8")
}

describe("recordAuditEvent", () => {
  it("creates the audit log file on first call and chains correctly", async () => {
    const r1 = await recordAuditEvent(config, {
      actorKind: "system",
      actorId: null,
      entityType: "audit-event",
      entityId: "test:genesis",
      action: "log.initialized",
    })
    expect(r1.lineIndex).toBe(0)
    expect(r1.event.prevSignature).toBe(GENESIS)
    expect(r1.event.signature).toMatch(/^[a-f0-9]{64}$/)

    const r2 = await recordAuditEvent(config, {
      actorKind: "operator",
      actorId: "jeremy",
      entityType: "test",
      entityId: "test:1",
      action: "test.action_1",
    })
    expect(r2.lineIndex).toBe(1)
    expect(r2.event.prevSignature).toBe(r1.event.signature)
    expect(r2.event.signature).toMatch(/^[a-f0-9]{64}$/)

    // The on-disk file should validate as a clean chain.
    const logContent = await fs.readFile(
      path.join(tmpRoot, "audit/audit-log.jsonl"),
      "utf8"
    )
    const result = validateAuditLog(logContent, {
      secret: SECRET,
      genesisSeed: GENESIS,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.events).toHaveLength(2)
      expect(result.value.chain.ok).toBe(true)
    }
  })

  it("supports per-engagement scope", async () => {
    await recordAuditEvent(config, {
      scopeDir: "engagements/test-eng/audit",
      actorKind: "system",
      actorId: null,
      entityType: "engagement",
      entityId: "engagements/test-eng/ENGAGEMENT.md",
      action: "engagement.created",
    })
    const exists = await fs
      .access(path.join(tmpRoot, "engagements/test-eng/audit/audit-log.jsonl"))
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)
  })

  it("invokes anchor sink at the configured cadence", async () => {
    const anchored: { lineIndex: number; signature: string }[] = []
    config.anchorSink = async ({ lineIndex, signature }) => {
      anchored.push({ lineIndex, signature })
    }
    config.anchorEveryLines = 2

    await recordAuditEvent(config, {
      actorKind: "system",
      actorId: null,
      entityType: "x",
      entityId: "x",
      action: "x.a",
    })
    expect(anchored).toHaveLength(0)
    await recordAuditEvent(config, {
      actorKind: "system",
      actorId: null,
      entityType: "x",
      entityId: "x",
      action: "x.b",
    })
    expect(anchored).toHaveLength(1)
    expect(anchored[0]!.lineIndex).toBe(1)
    await recordAuditEvent(config, {
      actorKind: "system",
      actorId: null,
      entityType: "x",
      entityId: "x",
      action: "x.c",
    })
    expect(anchored).toHaveLength(1)
    await recordAuditEvent(config, {
      actorKind: "system",
      actorId: null,
      entityType: "x",
      entityId: "x",
      action: "x.d",
    })
    expect(anchored).toHaveLength(2)
  })
})

describe("signArtifact", () => {
  it("writes signature.json next to the artifact + appends audit-log entry", async () => {
    await writeArtifact(
      "engagements/test-eng/AGREEMENT.md",
      "---\ntitle: Test Agreement\n---\n\n# Test\n"
    )

    const result = await signArtifact(config, {
      artifactPath: "engagements/test-eng/AGREEMENT.md",
      signer: "operator:jeremy",
      signerKind: "operator",
      method: "typed_name",
      evidence: {
        kind: "typed_name",
        signerName: "Jeremy",
        ipAddress: "192.0.2.1",
        userAgent: "Mozilla/5.0 test",
        nonce: "abc123",
      },
    })

    expect(result.signature.signer).toBe("operator:jeremy")
    expect(result.signaturePath).toMatch(
      /^engagements\/test-eng\/signatures\/operator-jeremy-/
    )

    // Signature file should exist on disk.
    const sigPath = path.join(tmpRoot, result.signaturePath)
    const sigContent = await fs.readFile(sigPath, "utf8")
    const parsed = JSON.parse(sigContent)
    expect(parsed.signer).toBe("operator:jeremy")
    expect(parsed.method).toBe("typed_name")

    // Engagement-scoped audit log should exist + verify.
    expect(result.auditLogPath).toBe(
      "engagements/test-eng/audit/audit-log.jsonl"
    )
    const logContent = await fs.readFile(
      path.join(tmpRoot, result.auditLogPath),
      "utf8"
    )
    const verify = validateAuditLog(logContent, {
      secret: SECRET,
      genesisSeed: GENESIS,
    })
    expect(verify.ok).toBe(true)
    if (verify.ok) {
      expect(verify.value.events).toHaveLength(1)
      expect(verify.value.events[0]!.action).toBe("signature.created")
    }
  })

  it("computes documentHash from artifact content when not provided", async () => {
    const content = "---\ntitle: X\n---\n\nhello world\n"
    await writeArtifact("x.md", content)

    const r = await signArtifact(config, {
      artifactPath: "x.md",
      signer: "operator:jeremy",
      signerKind: "operator",
      method: "typed_name",
      evidence: {
        kind: "typed_name",
        signerName: "x",
        ipAddress: "x",
        userAgent: "x",
        nonce: "x",
      },
    })

    // Hash should be deterministic SHA-256 of file bytes
    const { createHash } = await import("node:crypto")
    const expected = createHash("sha256").update(content, "utf8").digest("hex")
    expect(r.signature.documentHash).toBe(expected)
  })

  it("throws when artifact does not exist", async () => {
    await expect(
      signArtifact(config, {
        artifactPath: "nonexistent.md",
        signer: "operator:jeremy",
        signerKind: "operator",
        method: "typed_name",
        evidence: {
          kind: "typed_name",
          signerName: "x",
          ipAddress: "x",
          userAgent: "x",
          nonce: "x",
        },
      })
    ).rejects.toThrow(/not found/)
  })

  it("rejects evidence-method mismatch", async () => {
    await writeArtifact("x.md", "x")
    await expect(
      signArtifact(config, {
        artifactPath: "x.md",
        signer: "operator:jeremy",
        signerKind: "operator",
        method: "typed_name",
        evidence: {
          kind: "agent_confirm",
          modelId: "x",
          promptContextHash: "x".repeat(64),
        },
      })
    ).rejects.toThrow(/must match/)
  })
})

describe("pending-signatures index", () => {
  it("adds, lists, and removes entries", async () => {
    await addPendingSignatures(config, "engagements/x/INVOICE.md", [
      {
        signer: "operator:founder",
        method: "typed_name",
        deadline: "2026-05-15T17:00:00.000Z",
      },
    ])

    const list = await listPendingSignatures(config, "operator:founder")
    expect(list).toHaveLength(1)
    expect(list[0]!.artifactPath).toBe("engagements/x/INVOICE.md")
    expect(list[0]!.deadline).toBe("2026-05-15T17:00:00.000Z")

    await removePendingSignature(
      config,
      "operator:founder",
      "engagements/x/INVOICE.md"
    )
    const list2 = await listPendingSignatures(config, "operator:founder")
    expect(list2).toHaveLength(0)
  })

  it("dedupes when adding the same artifact twice for the same signer", async () => {
    await addPendingSignatures(config, "x.md", [
      { signer: "operator:a", method: "typed_name" },
    ])
    await addPendingSignatures(config, "x.md", [
      {
        signer: "operator:a",
        method: "click_through",
        deadline: "2026-06-01T00:00:00.000Z",
      },
    ])
    const list = await listPendingSignatures(config, "operator:a")
    expect(list).toHaveLength(1)
    expect(list[0]!.method).toBe("click_through") // updated to the latest
    expect(list[0]!.deadline).toBe("2026-06-01T00:00:00.000Z")
  })
})

describe("filesystem path safety", () => {
  it("rejects path-escape attempts", async () => {
    await expect(
      signArtifact(config, {
        artifactPath: "../escape.md",
        signer: "operator:jeremy",
        signerKind: "operator",
        method: "typed_name",
        evidence: {
          kind: "typed_name",
          signerName: "x",
          ipAddress: "x",
          userAgent: "x",
          nonce: "x",
        },
      })
    ).rejects.toThrow(/Path escape/)
  })
})

describe("concurrency — audit log chain integrity", () => {
  it("20 concurrent appends produce a valid linked chain", async () => {
    const N = 20
    const calls = Array.from({ length: N }, (_, i) =>
      recordAuditEvent(config, {
        actorKind: "operator",
        actorId: "operator:jeremy",
        entityType: "audit-event",
        entityId: `concurrent:${i}`,
        action: "test.concurrent",
      })
    )
    const results = await Promise.all(calls)

    // Every line must have a unique 0-based index and signatures should be unique.
    const indices = results.map(r => r.lineIndex).sort((a, b) => a - b)
    expect(indices).toEqual(Array.from({ length: N }, (_, i) => i))

    // The chain must verify against the produced log.
    const logAbs = path.join(tmpRoot, "audit/audit-log.jsonl")
    const jsonl = await fs.readFile(logAbs, "utf8")
    const verify = validateAuditLog(jsonl, {
      genesisSeed: GENESIS,
      secret: SECRET,
    })
    expect(verify.ok).toBe(true)
    if (verify.ok) {
      expect(verify.value.events).toHaveLength(N)
    }
  })
})

describe("concurrency — pending-signatures index integrity", () => {
  it("10 concurrent adds for distinct signers do not lose entries", async () => {
    const calls = Array.from({ length: 10 }, (_, i) =>
      addPendingSignatures(config, `engagements/x/file-${i}.md`, [
        {
          signer: `operator:signer-${i}`,
          method: "typed_name",
        },
      ])
    )
    await Promise.all(calls)

    for (let i = 0; i < 10; i++) {
      const list = await listPendingSignatures(config, `operator:signer-${i}`)
      expect(list).toHaveLength(1)
      expect(list[0]!.artifactPath).toBe(`engagements/x/file-${i}.md`)
    }
  })
})

describe("documentHash forgery close", () => {
  it("rejects expectedDocumentHash that does not match the artifact bytes", async () => {
    await writeArtifact("real.md", "real content\n")

    await expect(
      signArtifact(config, {
        artifactPath: "real.md",
        signer: "operator:jeremy",
        signerKind: "operator",
        method: "typed_name",
        evidence: {
          kind: "typed_name",
          signerName: "x",
          ipAddress: "x",
          userAgent: "x",
          nonce: "x",
        },
        expectedDocumentHash: "0".repeat(64),
      })
    ).rejects.toThrow(/expectedDocumentHash mismatch/)
  })

  it("accepts expectedDocumentHash that matches the artifact bytes", async () => {
    const content = "real content\n"
    await writeArtifact("real.md", content)

    const { createHash } = await import("node:crypto")
    const truth = createHash("sha256").update(content, "utf8").digest("hex")

    const r = await signArtifact(config, {
      artifactPath: "real.md",
      signer: "operator:jeremy",
      signerKind: "operator",
      method: "typed_name",
      evidence: {
        kind: "typed_name",
        signerName: "x",
        ipAddress: "x",
        userAgent: "x",
        nonce: "x",
      },
      expectedDocumentHash: truth,
    })

    expect(r.signature.documentHash).toBe(truth)
  })
})
