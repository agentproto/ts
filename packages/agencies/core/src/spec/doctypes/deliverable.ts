import { z } from "zod"
import {
  envelope,
  isoDatetimeOrDateSchema,
  kebabSlugSchema,
  partyRefStrictSchema,
  sha256HexSchema,
  workspacePathSchema,
} from "./_common.js"

/**
 * agentagencies/v1 — `DELIVERABLE.md` doctype.
 *
 * Submitted work product. Extends companies.sh `TASK.md` semantics with
 * attachments and deferment to agentgovernance/v1 for client validation
 * (typically `requiredSignatures: [counterparty:<id>]`).
 */

export const DELIVERABLE_STATUS = [
  "draft",
  "submitted",
  "under_review",
  "validated",
  "rejected",
  "revised",
  "superseded",
] as const
export const deliverableStatusSchema = z.enum(DELIVERABLE_STATUS)
export type DeliverableStatus = z.infer<typeof deliverableStatusSchema>

const requiredSignerSchema = z.object({
  signer: partyRefStrictSchema,
  method: z.enum([
    "typed_name",
    "agent_confirm",
    "click_through",
    "esign_external",
  ]),
  weight: z.number().min(0).optional(),
})

export const deliverableFrontmatterSchema = z.object({
  ...envelope("deliverable"),

  status: deliverableStatusSchema.default("draft"),

  /** Path to the linked TASK.md (companies.sh) if this deliverable resulted from one. */
  taskPath: workspacePathSchema.optional(),

  /**
   * Workspace-relative paths to attached work products (binary or other artifacts).
   * Each MAY be hashed; the hash anchors what was reviewed.
   */
  attachments: z
    .array(
      z.object({
        path: workspacePathSchema,
        contentHash: sha256HexSchema.optional(),
        kind: z.string().optional(), // "image", "pdf", "video", "document", "code", etc.
      })
    )
    .default([]),

  /** Required signatures for client validation (typically `[counterparty:<id>]`). */
  requiredSignatures: z.array(requiredSignerSchema).default([]),

  /** Hash of the deliverable.md frontmatter+body — what the signer signs against. */
  documentHash: sha256HexSchema.optional(),

  /** Self-ref for revision chain. */
  parentDeliverable: kebabSlugSchema.optional(),
  version: z.string().default("1"),

  submittedAt: isoDatetimeOrDateSchema.optional(),
  validatedAt: isoDatetimeOrDateSchema.optional(),
  rejectedAt: isoDatetimeOrDateSchema.optional(),
  rejectionReason: z.string().optional(),
})
export type DeliverableFrontmatter = z.infer<
  typeof deliverableFrontmatterSchema
>

export interface Deliverable {
  frontmatter: DeliverableFrontmatter
  body: string
}

export const DELIVERABLE_FILENAME = "DELIVERABLE.md" as const
