/**
 * Verify the IGovernanceFilesystem injection actually swaps the I/O backend.
 *
 * Without a NodeFilesystem default this would fail; without honoring
 * config.filesystem the in-memory adapter wouldn't capture the writes
 * (and audit-chain would silently fall back to disk).
 */

import { describe, it, expect } from "vitest"

import { recordAuditEvent } from "./audit-chain.js"
import { signArtifact } from "./sign-artifact.js"
import {
  addPendingSignatures,
  listPendingSignatures,
} from "./pending-signatures-index.js"
import type { DirectoryEntry, IGovernanceFilesystem } from "./filesystem.js"
import type { GovernanceConfig } from "./workspace-config.js"

class InMemoryFilesystem implements IGovernanceFilesystem {
  private files = new Map<string, string>()
  private dirs = new Set<string>()

  async ensureDir(absDir: string): Promise<void> {
    this.dirs.add(absDir)
  }

  async readFile(absPath: string): Promise<string | null> {
    return this.files.get(absPath) ?? null
  }

  async writeFileAtomic(absPath: string, content: string): Promise<void> {
    this.files.set(absPath, content)
  }

  async appendLine(absPath: string, line: string): Promise<void> {
    const prior = this.files.get(absPath) ?? ""
    this.files.set(absPath, prior + line + "\n")
  }

  async listDirectory(absDir: string): Promise<DirectoryEntry[]> {
    const prefix = absDir.endsWith("/") ? absDir : absDir + "/"
    const seen = new Map<string, DirectoryEntry>()
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) continue
      const rest = filePath.slice(prefix.length)
      const slash = rest.indexOf("/")
      if (slash === -1) {
        seen.set(rest, { name: rest, isDirectory: false })
      } else {
        const name = rest.slice(0, slash)
        if (!seen.has(name)) seen.set(name, { name, isDirectory: true })
      }
    }
    return Array.from(seen.values())
  }

  /** Test helper. */
  has(absPath: string): boolean {
    return this.files.has(absPath)
  }
  /** Test helper. */
  get(absPath: string): string | undefined {
    return this.files.get(absPath)
  }
  /** Test helper. */
  size(): number {
    return this.files.size
  }
}

const GENESIS = "a".repeat(64)
const HMAC = "b".repeat(64)

describe("IGovernanceFilesystem injection", () => {
  it("recordAuditEvent writes through the injected adapter (no disk I/O)", async () => {
    const fs = new InMemoryFilesystem()
    const config: GovernanceConfig = {
      workspaceRoot: "/virtual/ws",
      genesisSeed: GENESIS,
      hmacSecret: HMAC,
      filesystem: fs,
    }

    const result = await recordAuditEvent(config, {
      actorKind: "system",
      actorId: null,
      entityType: "test",
      entityId: "test-1",
      action: "test.event",
      payload: { ok: true },
    })

    expect(result.lineIndex).toBe(0)
    expect(fs.has("/virtual/ws/audit/audit-log.jsonl")).toBe(true)
    const log = fs.get("/virtual/ws/audit/audit-log.jsonl")!
    expect(log.endsWith("\n")).toBe(true)
    const row = JSON.parse(log.trim()) as { signature: string; action: string }
    expect(row.action).toBe("test.event")
    expect(typeof row.signature).toBe("string")
  })

  it("signArtifact writes signature.json + audit line through the adapter", async () => {
    const fs = new InMemoryFilesystem()
    const config: GovernanceConfig = {
      workspaceRoot: "/virtual/ws",
      genesisSeed: GENESIS,
      hmacSecret: HMAC,
      filesystem: fs,
    }

    // Seed the artifact.
    await fs.writeFileAtomic(
      "/virtual/ws/engagements/2026-acme/AGREEMENT.md",
      "# Agreement body\n"
    )

    const result = await signArtifact(config, {
      artifactPath: "engagements/2026-acme/AGREEMENT.md",
      signer: "operator:jeremy",
      signerKind: "operator",
      method: "typed_name",
      evidence: {
        kind: "typed_name",
        signerName: "Jeremy",
        ipAddress: "127.0.0.1",
        userAgent: "test",
        nonce: "abc123",
      },
    })

    expect(result.signaturePath).toMatch(
      /^engagements\/2026-acme\/signatures\/operator-jeremy-/
    )
    // Signature file landed in memory, never touched disk.
    expect(fs.has("/virtual/ws/" + result.signaturePath)).toBe(true)
    // Audit line for the signature was hash-chained into the per-engagement log.
    expect(
      fs.has("/virtual/ws/engagements/2026-acme/audit/audit-log.jsonl")
    ).toBe(true)
  })

  it("pending-signatures index is read+written via the adapter", async () => {
    const fs = new InMemoryFilesystem()
    const config: GovernanceConfig = {
      workspaceRoot: "/virtual/ws",
      genesisSeed: GENESIS,
      hmacSecret: HMAC,
      filesystem: fs,
    }

    await addPendingSignatures(config, "engagements/2026-acme/INVOICE.md", [
      { signer: "operator:founder", method: "typed_name" },
    ])

    const list = await listPendingSignatures(config, "operator:founder")
    expect(list).toHaveLength(1)
    expect(list[0]?.artifactPath).toBe("engagements/2026-acme/INVOICE.md")
    expect(fs.has("/virtual/ws/_index/pending-signatures.json")).toBe(true)
  })
})
