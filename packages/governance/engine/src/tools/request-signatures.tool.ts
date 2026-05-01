import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import {
  governanceToolContextSchema,
  type GovernanceToolContext,
} from "../workspace-config.js"

/**
 * AIP-14 contract for registering pending signatures on an artifact.
 *
 * Reads `governanceConfig` from per-call context. Body lives on the
 * AIP-30 PROVIDER (`@agentproto/governance-engine/provider`).
 */
export const requestSignaturesTool = defineTool({
  id: "governance.request-signatures",
  description:
    "Register that an artifact needs signatures from one or more signers. " +
    "Each signer becomes queryable via governance.list-pending-signatures. " +
    "The pending-signatures index is regeneratable from artifact frontmatter; " +
    "this tool is the cache-write side of that contract.",
  version: "0.1.0",
  inputSchema: z.object({
    artifact: z
      .string()
      .describe(
        "AIP-27 Ref compact form, file collection. Example: 'local:engagements/acme/proposal.md'."
      ),
    requiredSignatures: z
      .array(
        z.object({
          signer: z
            .string()
            .describe("AIP-27 Ref compact form, identity collection."),
          method: z
            .enum([
              "typed_name",
              "agent_confirm",
              "click_through",
              "esign_external",
            ])
            .optional(),
          weight: z.number().int().positive().optional(),
          deadline: z.iso.datetime().optional(),
        })
      )
      .min(1),
  }),
  outputSchema: z.object({
    added: z.number().int().nonnegative(),
  }),
  contextSchema:
    governanceToolContextSchema as z.ZodType<GovernanceToolContext>,
  mutates: ["fs:write"],
  approval: "auto",
  riskLevel: 1,
})
