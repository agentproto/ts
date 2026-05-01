/**
 * Provider body for the `governance.list-pending-signatures` TOOL contract.
 * Bound via `implementTool` — typed input/context flow from the
 * contract handle.
 */

import { defineRef, refMatchesCollection } from "@agentproto/ref"
import { ToolError } from "@agentproto/tool"
import { implementTool } from "@agentproto/driver"

import { listPendingSignatures } from "../../pending-signatures-index.js"
import { listPendingSignaturesTool } from "../../tools/list-pending-signatures.tool.js"

export const listPendingSignaturesBuiltin = implementTool(
  listPendingSignaturesTool,
  async ({ input, context }) => {
    if (!context?.governanceConfig) {
      throw new ToolError({
        code: "input_invalid",
        message: "context.governanceConfig is required",
        cause: { field: "context" },
      })
    }

    let parsed
    try {
      parsed = defineRef(input.signer)
    } catch (err) {
      throw new ToolError({
        code: "input_invalid",
        message: `signer: ${(err as Error).message}`,
        cause: err,
      })
    }
    if (!refMatchesCollection(parsed.value, "identity")) {
      throw new ToolError({
        code: "input_invalid",
        message: `signer: ref kind '${parsed.kind}' is not in the 'identity' collection`,
      })
    }
    const pending = await listPendingSignatures(
      context.governanceConfig,
      parsed.compact
    )
    return { pending }
  }
)
