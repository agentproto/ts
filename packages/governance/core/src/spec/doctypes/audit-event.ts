import { z } from "zod"

/**
 * agentgovernance/v1 — audit-log.jsonl line doctype.
 *
 * Each line of `<scope>/audit/audit-log.jsonl` is one audit event, encoded as
 * a single JSON object on one line (no embedded newlines).
 *
 * Scope is whatever folder hosts the log: per-engagement
 * (`engagements/<slug>/audit/audit-log.jsonl`) or per-workspace/guild
 * (`audit/audit-log.jsonl` for cross-engagement events).
 *
 * Hash chain protocol:
 *   signature_n = HMAC-SHA256(secret, signature_{n-1} ‖ canonical(row_n))
 *
 * The first line's `prevSignature` is the workspace genesis seed (vault-backed).
 * See `../hash-chain/protocol.md` for the canonical-bytes specification.
 */

export const ACTOR_KIND = [
  "operator",
  "user",
  "counterparty",
  "agent",
  "system",
] as const
export const actorKindSchema = z.enum(ACTOR_KIND)
export type ActorKind = z.infer<typeof actorKindSchema>

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, {
  message: "Expected lowercase hex SHA-256 (64 chars)",
})

/** Common entity types. Apps may extend via metadata or contributing entries. */
export const KNOWN_ENTITY_TYPES = [
  // governance-native
  "signature",
  "audit-event",
  "policy",
  "approval",
  // agency entities (when agentagencies/v1 is in use; not normative here)
  "engagement",
  "agreement",
  "deliverable",
  "invoice",
  "service",
  "counterparty",
  "routine",
  "procedure",
  // other extensions
  "task",
  "project",
  "company",
  "agent",
] as const

export const auditEventSchema = z.object({
  schema: z.literal("agentgovernance/v1"),
  doctype: z.literal("audit-event"),

  /** Who performed the action. */
  actorKind: actorKindSchema,
  /** Slug or canonical id; null for actorKind=system. */
  actorId: z.string().nullable(),

  /**
   * Free-form entity type. Implementations SHOULD use a known value from
   * KNOWN_ENTITY_TYPES; SHOULD NOT introduce new types ad-hoc.
   */
  entityType: z.string(),

  /**
   * Workspace-relative path to the entity (preferred) or a governance-internal
   * id when the entity has no file. Examples:
   *   engagements/2026-acme-website-redesign/AGREEMENT.md
   *   policies/invoice-cap-500eur/POLICY.md
   *   gov:approval:<idempotencyKey>
   */
  entityId: z.string().min(1),

  /**
   * Action verb in `<entity>.<verb>` form. Examples:
   *   signature.created
   *   signature.revoked
   *   approval.requested
   *   approval.granted
   *   engagement.status_changed
   *   invoice.issued
   */
  action: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, {
    message: "Expected '<entity>.<verb>' lowercase",
  }),

  /** Action-specific payload. Vendor extensions allowed under payload.<vendor>.* */
  payload: z.record(z.string(), z.unknown()).optional(),

  /** Hash chain: previous line's `signature` (or workspace genesis seed for first line). */
  prevSignature: sha256HexSchema,
  /** Hash chain: HMAC-SHA256(secret, prevSignature ‖ canonicalBytes(this row sans `signature`)). */
  signature: sha256HexSchema,

  /** Optional correlation ids for distributed tracing. */
  requestId: z.string().optional(),
  traceId: z.string().optional(),

  /** Optional human-actor evidence. */
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),

  /** ISO-8601 timestamp; UTC strongly recommended. */
  createdAt: z.iso.datetime(),

  /** Vendor-specific extensions allowed under metadata.<vendor>.* */
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export type AuditEvent = z.infer<typeof auditEventSchema>

/** Convenience: parse a single JSONL line. Returns parsed event or throws. */
export function parseAuditLine(line: string): AuditEvent {
  return auditEventSchema.parse(JSON.parse(line))
}
