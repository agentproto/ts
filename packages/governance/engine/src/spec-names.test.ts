import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { recordAuditEvent } from "./audit-chain.js"
import { signArtifact } from "./sign-artifact.js"
import type { GovernanceConfig } from "./workspace-config.js"

/**
 * The engine WRITES the canonical AIP-70 tag ("governance/v1") in new
 * signature.json files and audit-log rows. Readers keep accepting the
 * pre-AIP-70 "agentgovernance/v1" alias. These tests pin that write behavior.
 */

const GENESIS = "0".repeat(64)
const SECRET = "spec-names-e2e-secret"

let tmpRoot: string
let config: GovernanceConfig

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gov-spec-names-"))
  config = {
    workspaceRoot: tmpRoot,
    genesisSeed: GENESIS,
    hmacSecret: SECRET,
  }
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe("emitted spec name", () => {
  it("signArtifact writes signatures with the canonical governance/v1 tag", async () => {
    const artifactAbs = path.join(tmpRoot, "AGREEMENT.md")
    await fs.writeFile(artifactAbs, "# Agreement\n", "utf8")

    const result = await signArtifact(config, {
      artifactPath: "AGREEMENT.md",
      signer: "operator:jeremy",
      signerKind: "operator",
      method: "typed_name",
      evidence: {
        kind: "typed_name",
        signerName: "Jeremy",
        ipAddress: "192.0.2.1",
        userAgent: "Mozilla/5.0",
        nonce: "abc123",
      },
    })

    expect(result.signature.schema).toBe("governance/v1")
    const onDisk = JSON.parse(
      await fs.readFile(
        path.join(tmpRoot, result.signaturePath),
        "utf8",
      ),
    ) as { schema: string }
    expect(onDisk.schema).toBe("governance/v1")
  })

  it("recordAuditEvent writes rows with the canonical governance/v1 tag", async () => {
    const r = await recordAuditEvent(config, {
      actorKind: "system",
      actorId: null,
      entityType: "audit-event",
      entityId: "test:genesis",
      action: "log.initialized",
    })
    expect(r.event.schema).toBe("governance/v1")

    const onDisk = JSON.parse(
      await fs.readFile(path.join(tmpRoot, r.logPath), "utf8"),
    ) as { schema: string }
    expect(onDisk.schema).toBe("governance/v1")
  })
})
