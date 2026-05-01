import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import {
  governanceToolContextSchema,
  type GovernanceToolContext,
} from "../workspace-config.js"

/**
 * AIP-14 contract for appending an event to the workspace audit log.
 *
 * Reads `governanceConfig` from the per-call context (validated by
 * `contextSchema`). Body lives on the AIP-30 PROVIDER
 * (`@agentproto/governance-engine/provider`).
 */
export const recordAuditEventTool = defineTool({
  id: "governance.record-audit-event",
  description:
    "Append a hash-chained event to the workspace (or engagement) audit log. " +
    "The runtime serialises concurrent appends per log path and computes the " +
    "chain signature against the prior tail. Use for any non-signature event " +
    "that needs to be auditable.",
  version: "0.1.0",
  inputSchema: z.object({
    scopeDir: z
      .string()
      .optional()
      .describe(
        "Workspace-relative folder containing audit-log.jsonl. Default: 'audit'. " +
          "Engagement-scoped example: 'engagements/2026-acme/audit'."
      ),
    actorKind: z.enum(["operator", "user", "agent", "system", "counterparty"]),
    actor: z
      .string()
      .nullable()
      .describe(
        "AIP-27 Ref compact form for the actor (identity collection), or null " +
          "for system events. Example: 'operator:atlas'."
      ),
    entityType: z.string().min(1),
    entity: z
      .string()
      .describe(
        "AIP-27 Ref compact form for the entity the event is about. May be a " +
          "file ref ('local:...') or an identity ref ('operator:...')."
      ),
    action: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, {
      message:
        "action must be '<entity>.<verb>' lowercase, e.g., 'policy.evaluated'",
    }),
    payload: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string().optional(),
    traceId: z.string().optional(),
    idempotencyKey: z.string().min(1).optional(),
  }),
  outputSchema: z.object({
    logPath: z.string(),
    lineIndex: z.number().int().nonnegative(),
    anchored: z.boolean(),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  contextSchema:
    governanceToolContextSchema as z.ZodType<GovernanceToolContext>,
  mutates: ["fs:write"],
  approval: "auto",
  riskLevel: 1,
})
