import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import {
  governanceToolContextSchema,
  type GovernanceToolContext,
} from "../workspace-config.js"

/**
 * AIP-14 contract for signing an artifact.
 *
 * `governanceConfig` is read from the per-call `context` (validated by
 * `contextSchema`) — a single tool instance serves multiple workspaces /
 * tenants without re-instantiation. Hosts that wire the tool through a
 * Mastra adapter use `resolveContext` to project per-request guildId →
 * config.
 *
 * Input fields use AIP-27 `Ref` compact strings — `artifact: "local:..."`,
 * `signer: "operator:..."`. The body lives on the AIP-30 PROVIDER
 * (`@agentproto/governance-engine/provider`); this file carries only
 * the abstract contract per AIP-14.
 */
export const signArtifactTool = defineTool({
  id: "governance.sign-artifact",
  description:
    "Sign an artifact: hash the artifact bytes, write a signature.json next to it, " +
    "append a hash-chained `signature.created` event to the audit log. The runtime " +
    "always re-hashes from disk; supplying `expectedDocumentHash` asserts the " +
    "expected hash and rejects on mismatch (does NOT substitute).",
  version: "0.1.0",
  inputSchema: z.object({
    artifact: z
      .string()
      .describe(
        "AIP-27 Ref compact form for the artifact, in the `file` collection. " +
          "Example: `local:engagements/acme/proposal.md`."
      ),
    signer: z
      .string()
      .describe(
        "AIP-27 Ref compact form for the signer, in the `identity` collection. " +
          "Example: `operator:atlas`, `email:counterparty@example.com`."
      ),
    signerKind: z.enum([
      "operator",
      "user",
      "counterparty",
      "agent",
      "external",
    ]),
    signerEmail: z.email().optional(),
    method: z.enum([
      "typed_name",
      "agent_confirm",
      "click_through",
      "esign_external",
    ]),
    evidence: z
      .unknown()
      .describe(
        "Method-specific evidence object whose `kind` MUST equal `method`. " +
          "Shape per AIP-7 signature evidence types."
      ),
    expectedDocumentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
      .describe(
        "Optional caller-asserted SHA-256 of the artifact bytes. Rejects on " +
          "mismatch with the actual on-disk hash. Never substitutes."
      ),
    idempotencyKey: z.string().min(1).optional(),
  }),
  outputSchema: z.object({
    signaturePath: z.string(),
    auditLogPath: z.string(),
    auditLineIndex: z.number().int().nonnegative(),
    documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  contextSchema:
    governanceToolContextSchema as z.ZodType<GovernanceToolContext>,
  mutates: ["fs:write"],
  approval: "on-mutate",
  riskLevel: 2,
})
