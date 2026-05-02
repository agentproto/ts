/**
 * AIP-15 WORKFLOW.md frontmatter zod schema.
 *
 * Generated from `resources/aip-15/draft/WORKFLOW.schema.json` via
 * json-schema-to-zod. Imported by both `define-workflow.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-workflow.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const workflowFrontmatterSchema = z.object({ "name": z.string().min(1).max(80), "id": z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$")).min(2).max(64), "description": z.string().min(1).max(2000), "version": z.string().regex(new RegExp("^\\d+\\.\\d+\\.\\d+(?:[-+][a-zA-Z0-9.-]+)?$")), "entry": z.string().optional(), "inputs": z.any().describe("Defined by AIP-16 — the IO `inputs` block."), "outputs": z.any().describe("Defined by AIP-16 — the IO `outputs` block."), "steps": z.array(z.any()).min(1), "start": z.string().optional(), "suspendable": z.boolean().optional(), "triggers": z.array(z.any()).default([] as never), "requires": z.object({ "network": z.array(z.string()).optional(), "fs.read": z.array(z.string()).optional(), "fs.write": z.array(z.string()).optional(), "env": z.array(z.string()).optional(), "secrets": z.array(z.string()).optional(), "tools": z.array(z.string()).optional() }).strict().optional(), "approval": z.any().default("per-step"), "risk_level": z.number().int().gte(0).lte(3).optional(), "timeout_ms": z.number().int().gte(1).default(600000), "max_steps": z.number().int().gte(1).default(100), "retry": z.any().optional(), "cost_class": z.enum(["trivial","metered","expensive"]).default("metered"), "tags": z.array(z.string().regex(new RegExp("^[a-z][a-z0-9-]*$"))).default([] as never), "metadata": z.record(z.string(), z.any()).default({} as never), "inputsFiles": z.any().describe("Defined by AIP-16 — the IO `inputsFiles` block.").optional(), "outputsFiles": z.any().describe("Defined by AIP-16 — the IO `outputsFiles` block.").optional(), "runtime": z.any().describe("Defined by AIP-17 — the runner block.").optional() }).strict().describe("Validates the YAML frontmatter portion of an AIP-15 WORKFLOW.md manifest.")

export type WorkflowFrontmatter = z.infer<typeof workflowFrontmatterSchema>
