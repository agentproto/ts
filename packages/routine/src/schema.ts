/**
 * AIP-41 ROUTINE.md frontmatter zod schema.
 *
 * Generated from `resources/aip-41/draft/ROUTINE.schema.json` via
 * json-schema-to-zod. Imported by both `define-routine.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-routine.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

/**
 * `target` union — hand-tightened from the generator's `z.any()`, NOT
 * re-run from `scaffold-aip` (see packages/routine/README.md "Runtime
 * bridge" section for the full rationale). Plain `z.union` rather than
 * `z.discriminatedUnion`: the four variants are told apart by which key is
 * present (`tool` / `agent` / `workflow` / `action`), not a shared literal
 * discriminator field.
 *
 * `agent` is NEW — not yet in the upstream AIP-41 draft JSON Schema
 * (flagged as a specs-repo follow-up in the PR, not applied here).
 */
const targetToolSchema = z
  .object({
    tool: z.string().min(1).describe("AIP-14 TOOL id (pin specific implementation)."),
    inputs: z.record(z.string(), z.unknown()).describe("Invocation payload. May reference ${{ vault.* }} and ${{ now }}.").optional(),
  })
  .strict()

const targetAgentSchema = z
  .object({
    agent: z
      .object({
        adapter: z.string().min(1).describe("Agent adapter slug (e.g. 'claude-code', 'hermes')."),
        prompt: z.string().min(1).describe("Initial prompt / consigne sent to the spawned agent."),
        model: z.string().min(1).describe("Optional model identifier forwarded to the adapter.").optional(),
        cwd: z.string().min(1).describe("Working directory for the spawned session.").optional(),
      })
      .strict(),
  })
  .strict()

const targetWorkflowSchema = z
  .object({
    workflow: z
      .union([
        z.string().min(1),
        z
          .object({
            ref: z.string().optional(),
            file: z.string().optional(),
            inline: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      ])
      .describe("AIP-15 WORKFLOW ref."),
    inputs: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const targetActionSchema = z
  .object({
    action: z.string().min(1).describe("AIP-39 ACTION ref. Resolver picks tool implementation."),
    inputs: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const routineTargetSchema = z
  .union([targetToolSchema, targetAgentSchema, targetWorkflowSchema, targetActionSchema])
  .describe("What the routine invokes when it fires.")

export const routineFrontmatterSchema = z.object({ "schema": z.literal("routine/v1"), "id": z.string().regex(new RegExp("^[a-z0-9@][a-z0-9.@/_-]*$")).min(2).max(80).describe("Machine identifier. Lowercase, digits, dashes, dots, optional @owner/ prefix. Unique within the registry that hosts the routine."), "description": z.string().min(1).max(2000).describe("One-paragraph purpose."), "version": z.string().regex(new RegExp("^\\d+\\.\\d+\\.\\d+(?:[-+][\\w.\\-]+)?$")).describe("Spec version of THIS file.").default("1.0.0"), "schedule": z.any().describe("When the routine fires."), "target": routineTargetSchema, "identity": z.any().describe("Identity that owns the routine fire (AIP-23). Defaults to host policy.").optional(), "retry": z.any().describe("Retry behaviour on failure.").optional(), "on_failure": z.any().describe("Where to route failures after retries exhaust.").optional(), "history": z.any().describe("Run history retention.").optional(), "fires_events": z.array(z.string().min(1)).describe("AIP-37 LIFECYCLE event names this routine fires.").default(["routine-triggered","routine-completed","routine-failed"]), "enabled": z.boolean().describe("If false, routine registers but does not fire. Useful for staging.").default(true), "tags": z.array(z.string()).describe("Free-form discovery tags.").default([] as never), "metadata": z.record(z.string(), z.any()).describe("Free-form, namespaced.").optional() }).strict().describe("Validates the YAML frontmatter portion of an AIP-41 ROUTINE.md manifest. Decouples 'when' (schedule) from 'what' (target action/workflow/tool).")

export type RoutineFrontmatter = z.infer<typeof routineFrontmatterSchema>
