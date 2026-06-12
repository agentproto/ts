/**
 * AIP-12 PLAYBOOK.md frontmatter zod schema.
 *
 * Generated from `resources/aip-12/draft/PLAYBOOK.schema.json` via
 * json-schema-to-zod. Imported by both `define-playbook.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-playbook.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const playbookFrontmatterSchema = z.object({ "schema": z.literal("playbooks/v1"), "slug": z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$")).min(2).max(80), "title": z.string().min(1).max(200), "entry": z.string().describe("Optional path to the entry file exposing definePlaybook. Defaults to playbook.ts.").optional(), "targets": z.array(z.any()).min(1).describe("DEPRECATED in favor of `selector`. Legacy axis-ambiguous binding — kept valid forever.").optional(), "selector": z.record(z.string(), z.any()).describe("Typed attachment binding evaluated against the subject's dimensions. Wins over `targets`/`binds_operator` when present.").optional(), "kind": z.enum(["overlay","block-replacement"]).default("overlay"), "block": z.string().regex(new RegExp("^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*$")).describe("Required when kind is 'block-replacement' — the named persona block to swap.").optional(), "priority": z.number().int().gte(0).lte(100).default(50), "lock_check": z.array(z.any()).describe("Locked persona traits this overlay MUST NOT modify. Author intent — runtime enforces independently.").default([] as never), "ttl": z.string().regex(new RegExp("^P(?:\\d+Y)?(?:\\d+M)?(?:\\d+W)?(?:\\d+D)?(?:T(?:\\d+H)?(?:\\d+M)?(?:\\d+S)?)?$")).describe("Optional ISO 8601 duration. Auto-archives at updated_at + ttl.").optional(), "evidence": z.array(z.any()).min(1), "status": z.enum(["shadow","active","archived"]).default("shadow"), "supersedes": z.array(z.any()).default([] as never), "history": z.array(z.any()).describe("Append-only audit trail of deltas, promotions, and archivals applied to this playbook.").default([] as never), "binds_operator": z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$")).describe("Optional — the specific operator (per AIP-9) this playbook is bound to. Narrower than targets[].").optional(), "created_at": z.string().datetime({ offset: true }).optional(), "updated_at": z.string().datetime({ offset: true }).optional(), "tags": z.array(z.string().regex(new RegExp("^[a-z][a-z0-9-]*$"))).default([] as never), "metadata": z.record(z.string(), z.any()).describe("Vendor extensions go under metadata.<vendor>.").default({} as never) }).strict().and(z.any()).describe("Validates the YAML frontmatter portion of an AIP-12 PLAYBOOK.md overlay manifest.")

export type PlaybookFrontmatter = z.infer<typeof playbookFrontmatterSchema>
