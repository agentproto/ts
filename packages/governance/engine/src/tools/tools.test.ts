import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ToolError } from "@agentproto/tool"
import { runTool } from "@agentproto/driver"

import {
  signArtifactTool,
  recordAuditEventTool,
  requestSignaturesTool,
  listPendingSignaturesTool,
} from "./index.js"
import { governanceProvider } from "../provider/index.js"
import type { GovernanceConfig } from "../workspace-config.js"

/**
 * Tests dispatch through `runTool` from `@agentproto/driver` —
 * the AIP-30 end-to-end pipeline (resolver → input validation → context
 * validation → mapping → provider.execute[id] → output validation). The
 * pre-AIP-14-split `tool.invoke(...)` shortcut no longer exists; the
 * provider's `governance-engine-builtin` is the only candidate so the
 * resolver picks it deterministically.
 */
const CANDIDATES = [governanceProvider] as const

const GENESIS = "0".repeat(64)
const SECRET = "tools-test-secret"

let tmpRoot: string
let context: { governanceConfig: GovernanceConfig }

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gov-tools-"))
  const config: GovernanceConfig = {
    workspaceRoot: tmpRoot,
    genesisSeed: GENESIS,
    hmacSecret: SECRET,
  }
  context = { governanceConfig: config }
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

async function writeArtifact(rel: string, content: string): Promise<void> {
  const abs = path.join(tmpRoot, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, "utf8")
}

describe("governance.sign-artifact tool", () => {
  it("signs an artifact via Ref-typed inputs + context-injected config", async () => {
    await writeArtifact("acme/proposal.md", "real content\n")
    const r = await runTool({
      tool: signArtifactTool,
      candidates: CANDIDATES,
      input: {
        artifact: "local:acme/proposal.md",
        signer: "operator:atlas",
        signerKind: "operator",
        method: "typed_name",
        evidence: {
          kind: "typed_name",
          signerName: "Atlas",
          ipAddress: "127.0.0.1",
          userAgent: "test",
          nonce: "n1",
        },
      },
      context,
    })
    expect(r.signaturePath).toMatch(/acme\/signatures\/.*\.signature\.json$/)
    expect(r.documentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(r.auditLineIndex).toBe(0)
  })

  it("rejects when context is missing governanceConfig", async () => {
    await writeArtifact("x.md", "x")
    await expect(
      runTool({
        tool: signArtifactTool,
        candidates: CANDIDATES,
        input: {
          artifact: "local:x.md",
          signer: "operator:atlas",
          signerKind: "operator",
          method: "typed_name",
          evidence: {
            kind: "typed_name",
            signerName: "x",
            ipAddress: "x",
            userAgent: "x",
            nonce: "x",
          },
        },
        context: {} as never,
      })
    ).rejects.toMatchObject({ code: "input_invalid" })
  })

  it("rejects non-file artifact ref kind", async () => {
    await expect(
      runTool({
        tool: signArtifactTool,
        candidates: CANDIDATES,
        input: {
          artifact: "operator:atlas",
          signer: "operator:atlas",
          signerKind: "operator",
          method: "typed_name",
          evidence: {
            kind: "typed_name",
            signerName: "x",
            ipAddress: "x",
            userAgent: "x",
            nonce: "x",
          },
        },
        context,
      })
    ).rejects.toThrow(ToolError)
  })

  it("rejects non-identity signer ref kind", async () => {
    await writeArtifact("x.md", "x")
    await expect(
      runTool({
        tool: signArtifactTool,
        candidates: CANDIDATES,
        input: {
          artifact: "local:x.md",
          signer: "local:not-an-identity.md",
          signerKind: "operator",
          method: "typed_name",
          evidence: {
            kind: "typed_name",
            signerName: "x",
            ipAddress: "x",
            userAgent: "x",
            nonce: "x",
          },
        },
        context,
      })
    ).rejects.toThrow(/identity/)
  })
})

describe("governance.request-signatures + list-pending-signatures", () => {
  it("round-trips pending signatures via Ref-typed inputs", async () => {
    await runTool({
      tool: requestSignaturesTool,
      candidates: CANDIDATES,
      input: {
        artifact: "local:engagements/x/INVOICE.md",
        requiredSignatures: [
          { signer: "operator:founder", method: "typed_name" },
          { signer: "email:cfo@acme.com", method: "esign_external" },
        ],
      },
      context,
    })

    const list = await runTool({
      tool: listPendingSignaturesTool,
      candidates: CANDIDATES,
      input: { signer: "operator:founder" },
      context,
    })
    expect(list.pending).toHaveLength(1)
    expect(list.pending[0]!.artifactPath).toBe("engagements/x/INVOICE.md")
  })

  it("multiple workspaces — same tool, different context", async () => {
    // Workspace A
    const tmpA = await fs.mkdtemp(path.join(os.tmpdir(), "gov-a-"))
    const ctxA = {
      governanceConfig: {
        workspaceRoot: tmpA,
        genesisSeed: GENESIS,
        hmacSecret: SECRET,
      },
    }
    // Workspace B
    const tmpB = await fs.mkdtemp(path.join(os.tmpdir(), "gov-b-"))
    const ctxB = {
      governanceConfig: {
        workspaceRoot: tmpB,
        genesisSeed: GENESIS,
        hmacSecret: SECRET,
      },
    }

    await runTool({
      tool: requestSignaturesTool,
      candidates: CANDIDATES,
      input: {
        artifact: "local:a/file.md",
        requiredSignatures: [
          { signer: "operator:atlas", method: "typed_name" },
        ],
      },
      context: ctxA,
    })
    await runTool({
      tool: requestSignaturesTool,
      candidates: CANDIDATES,
      input: {
        artifact: "local:b/file.md",
        requiredSignatures: [
          { signer: "operator:atlas", method: "typed_name" },
        ],
      },
      context: ctxB,
    })

    const listA = await runTool({
      tool: listPendingSignaturesTool,
      candidates: CANDIDATES,
      input: { signer: "operator:atlas" },
      context: ctxA,
    })
    const listB = await runTool({
      tool: listPendingSignaturesTool,
      candidates: CANDIDATES,
      input: { signer: "operator:atlas" },
      context: ctxB,
    })

    expect(listA.pending).toHaveLength(1)
    expect(listA.pending[0]!.artifactPath).toBe("a/file.md")
    expect(listB.pending).toHaveLength(1)
    expect(listB.pending[0]!.artifactPath).toBe("b/file.md")

    await fs.rm(tmpA, { recursive: true, force: true })
    await fs.rm(tmpB, { recursive: true, force: true })
  })
})

describe("governance.record-audit-event tool", () => {
  it("appends an event with Ref-typed actor + entity", async () => {
    const r = await runTool({
      tool: recordAuditEventTool,
      candidates: CANDIDATES,
      input: {
        actorKind: "operator",
        actor: "operator:atlas",
        entityType: "policy",
        entity: "local:policies/budget/POLICY.md",
        action: "policy.evaluated",
        payload: { result: "allowed" },
      },
      context,
    })
    expect(r.lineIndex).toBe(0)
    expect(r.signature).toMatch(/^[a-f0-9]{64}$/)
  })

  it("accepts null actor for system events", async () => {
    const r = await runTool({
      tool: recordAuditEventTool,
      candidates: CANDIDATES,
      input: {
        actorKind: "system",
        actor: null,
        entityType: "audit-event",
        entity: "local:audit/audit-log.jsonl",
        action: "log.initialized",
      },
      context,
    })
    expect(r.lineIndex).toBe(0)
  })
})
