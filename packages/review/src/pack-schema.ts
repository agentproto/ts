/**
 * AIP-62 REVIEW-PACK.md frontmatter zod schema.
 *
 * Generated from `resources/aip-62/draft/REVIEW-PACK.schema.json` via
 * json-schema-to-zod. Imported by both `define-review.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-review.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const reviewPackFrontmatterSchema = z.object({ "kind": z.literal("review-pack"), "id": z.string().regex(new RegExp("^[a-z][a-z0-9-]*$")).max(64), "version": z.string().regex(new RegExp("^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$")), "description": z.string().optional(), "checks": z.array(z.discriminatedUnion("kind", [z.object({ "id": z.string().regex(new RegExp("^[a-z][a-z0-9-]*$")).max(64), "kind": z.literal("command"), "description": z.string().optional(), "run": z.string().min(1), "cwd": z.string().optional(), "blocking": z.boolean().default(true), "timeoutMs": z.number().int().gt(0).default(600000), "effects": z.literal(false).optional() }).strict(), z.object({ "id": z.string().regex(new RegExp("^[a-z][a-z0-9-]*$")).max(64), "kind": z.literal("agent"), "description": z.string().optional(), "preset": z.string().min(1).describe("Optional in a pack. The consumer MUST supply one (override.preset, uses.preset, or this default) or resolution fails.").optional(), "rubric": z.string().min(1), "blockOn": z.enum(["high","medium","low"]).default("high"), "blocking": z.boolean().default(true), "timeoutMs": z.number().int().gt(0).default(900000), "effects": z.literal(false).optional() }).strict()])).min(1) }).strict().describe("The YAML frontmatter of a review pack: a reusable set of checks a REVIEW.md imports through uses[]. A pack has no target, bindings, or prepare phase, and none of its checks may have effects. Check ids MUST be unique within the pack (parser-enforced). Rubric paths are relative to the pack root and confined to it. Unknown keys are errors.")

export type ReviewPackFrontmatter = z.infer<typeof reviewPackFrontmatterSchema>
