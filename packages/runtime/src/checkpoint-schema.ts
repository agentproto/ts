/**
 * Contract for the persisted context checkpoint (`schemaVersion: 1`).
 *
 * The zod schema below is the source of truth; `schemas/checkpoint.v1.json`
 * is generated from it (`pnpm --filter @agentproto/runtime gen:checkpoint-schema`)
 * and a test fails when the two drift. Objects are loose on purpose: fields
 * may be ADDED under v1, but removing/renaming one or changing a type bumps
 * `schemaVersion`.
 */

import { z } from "zod"

/** Version stamped on every checkpoint this build writes. */
export const CHECKPOINT_SCHEMA_VERSION = 1 as const

const pct = z.number().min(0).max(100)

export const contextCheckpointPolicySchema = z.looseObject({
  mode: z.enum(["manual", "ask", "auto"]),
  warnAtPct: pct,
  compactAtPct: pct,
  continueFreshAtPct: pct,
  hardStopAtPct: pct,
  goal: z.boolean(),
  plan: z.boolean(),
  decisions: z.boolean(),
  changedFiles: z.boolean(),
  gitStatus: z.boolean(),
  tests: z.boolean(),
  errors: z.boolean(),
  risks: z.boolean(),
  nextStep: z.boolean(),
  config: z.boolean(),
  label: z.string(),
})

export const contextCheckpointSectionsSchema = z.looseObject({
  goal: z.string().optional(),
  plan: z.string().optional(),
  decisions: z.string().optional(),
  changedFiles: z.string().optional(),
  gitStatus: z.string().optional(),
  tests: z.string().optional(),
  errors: z.string().optional(),
  risks: z.string().optional(),
  nextStep: z.string().optional(),
  config: z.string().optional(),
  notes: z.string().optional().describe("Free-text notes the operator attached to the handoff."),
})

export const checkpointHandoffTurnSchema = z.looseObject({
  status: z
    .enum(["answered", "skipped", "failed"])
    .describe(
      "answered: the source session replied with a valid summary; skipped: not requested or no live idle session; failed: asked but timed out / unusable reply.",
    ),
  reason: z.string().optional(),
})

export const contextCheckpointSchema = z
  .looseObject({
    schemaVersion: z.literal(CHECKPOINT_SCHEMA_VERSION),
    checkpointId: z.string(),
    sourceSessionId: z.string(),
    createdAt: z.string().describe("ISO 8601 creation timestamp."),
    contextPct: z.number().describe("Context percentage that triggered the checkpoint."),
    policy: contextCheckpointPolicySchema,
    sections: contextCheckpointSectionsSchema.describe(
      "Sections requested and present. A section with nothing real to say is omitted, never a placeholder.",
    ),
    handoffTurn: checkpointHandoffTurnSchema.optional(),
    recentDigest: z.string(),
    originalTranscriptPath: z.string(),
    checkpointPath: z.string(),
    nextAction: z.enum(["continue", "compact_then_continue", "ask"]),
  })
  .meta({
    title: "AgentProto context checkpoint",
    description:
      "Structured handoff document persisted next to a session's events.jsonl and used to seed a fresh continuation session.",
  })

/** The JSON Schema (draft 2020-12) published as `schemas/checkpoint.v1.json`. */
export function buildCheckpointJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(contextCheckpointSchema) as Record<string, unknown>
}
