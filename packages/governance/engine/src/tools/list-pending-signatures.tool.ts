import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import {
  governanceToolContextSchema,
  type GovernanceToolContext,
} from "../workspace-config.js"

/**
 * AIP-14 contract for the read-only query of pending signatures.
 *
 * Reads `governanceConfig` from per-call context. Body lives on the
 * AIP-30 PROVIDER (`@agentproto/governance-engine/provider`).
 */
export const listPendingSignaturesTool = defineTool({
  id: "governance.list-pending-signatures",
  description:
    "List artifacts awaiting signature from a given signer. Reads from the " +
    "pending-signatures index (regeneratable from artifact frontmatter).",
  version: "0.1.0",
  inputSchema: z.object({
    signer: z
      .string()
      .describe("AIP-27 Ref compact form, identity collection."),
  }),
  outputSchema: z.object({
    pending: z.array(
      z.object({
        artifactPath: z.string(),
        deadline: z.string().optional(),
        requestedAt: z.string(),
        method: z.string().optional(),
        weight: z.number().optional(),
      })
    ),
  }),
  contextSchema:
    governanceToolContextSchema as z.ZodType<GovernanceToolContext>,
  mutates: [],
  approval: "auto",
  riskLevel: 0,
  idempotent: true,
})
