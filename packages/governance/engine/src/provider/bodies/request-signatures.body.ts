/**
 * Provider body for the `governance.request-signatures` TOOL contract.
 * Bound via `implementTool` — typed input/context flow from the
 * contract handle.
 */

import { ToolError } from "@agentproto/tool"
import { implementTool } from "@agentproto/driver"

import { addPendingSignatures } from "../../pending-signatures-index.js"
import { requestSignaturesTool } from "../../tools/request-signatures.tool.js"
import { legacyArtifactPath, parseAndAssertCollection } from "../helpers.js"

export const requestSignaturesBuiltin = implementTool(
  requestSignaturesTool,
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
    const artifactPath = legacyArtifactPath(artifactRef.value)

    const required = input.requiredSignatures.map(r => {
      const sigRef = parseAndAssertCollection(r.signer, "identity", "signer")
      return {
        signer: sigRef.compact,
        ...(r.method !== undefined ? { method: r.method } : {}),
        ...(r.weight !== undefined ? { weight: r.weight } : {}),
        ...(r.deadline !== undefined ? { deadline: r.deadline } : {}),
      }
    })

    await addPendingSignatures(context.governanceConfig, artifactPath, required)
    return { added: required.length }
  }
)
