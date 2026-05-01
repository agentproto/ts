/**
 * Provider body for the `governance.sign-artifact` TOOL contract.
 *
 * Bound to `signArtifactTool` via `implementTool` — input/context types
 * flow from the contract handle's generics, so the body needs no manual
 * casts. The matching `defineTool` handle in
 * `tools/sign-artifact.tool.ts` carries only the contract (id, schemas,
 * mutates, approval, riskLevel) per AIP-14.
 */

import { ToolError } from "@agentproto/tool"
import { implementTool } from "@agentproto/driver"

import { signArtifact } from "../../sign-artifact.js"
import { signArtifactTool } from "../../tools/sign-artifact.tool.js"
import {
  legacyArtifactPath,
  legacySignerString,
  parseAndAssertCollection,
} from "../helpers.js"

export const signArtifactBuiltin = implementTool(
  signArtifactTool,
  async ({ input, context }) => {
    if (!context?.governanceConfig) {
      throw new ToolError({
        code: "input_invalid",
        message: "context.governanceConfig is required",
        cause: { field: "context" },
      })
    }

    const artifactRef = parseAndAssertCollection(
      input.artifact,
      "file",
      "artifact"
    )
    const signerRef = parseAndAssertCollection(
      input.signer,
      "identity",
      "signer"
    )

    // Bridge to legacy runtime input (string forms). M1.5 makes this go away.
    const artifactPath = legacyArtifactPath(artifactRef.value)
    const signerLegacy = legacySignerString(signerRef.value)

    const result = await signArtifact(context.governanceConfig, {
      artifactPath,
      signer: signerLegacy,
      signerKind: input.signerKind,
      ...(input.signerEmail !== undefined
        ? { signerEmail: input.signerEmail }
        : {}),
      method: input.method,
      evidence: input.evidence as never,
      ...(input.expectedDocumentHash !== undefined
        ? { expectedDocumentHash: input.expectedDocumentHash }
        : {}),
      ...(input.idempotencyKey !== undefined
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
    })

    return {
      signaturePath: result.signaturePath,
      auditLogPath: result.auditLogPath,
      auditLineIndex: result.auditLineIndex,
      documentHash: result.signature.documentHash,
    }
  }
)
