/**
 * AIP-34 WORKSPACE.md frontmatter zod schema.
 *
 * Generated from `resources/aip-34/draft/WORKSPACE.schema.json` via
 * json-schema-to-zod. Imported by both `define-workspace.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-workspace.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const workspaceFrontmatterSchema = z.object({ "schema": z.literal("workspace/v1"), "id": z.string().regex(new RegExp("^@[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$")).describe("Globally addressable id `@<owner-slug>/<workspace-slug>`. Lowercase kebab-case, immutable across the workspace's lifetime."), "version": z.string().regex(new RegExp("^\\d+\\.\\d+\\.\\d+(?:[-+][\\w.\\-]+)?$")).describe("Spec version of THIS file. Bump on breaking shape change."), "name": z.string().min(1).max(80).describe("Human-readable display name."), "description": z.string().max(2000).describe("One-paragraph purpose.").optional(), "owner": z.object({ "type": z.enum(["guild","user","org"]), "id": z.string().min(1), "slug": z.string().regex(new RegExp("^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$")).min(1).describe("Owner-side slug. MUST match the slug suffix of the workspace `id`.") }).strict(), "storage": z.any().describe("AIP-35 STORAGE block. Required. Inline / ref / file."), "sandbox": z.any().describe("AIP-36 SANDBOX block. Optional — when absent, command-execution tools MUST be unavailable.").optional(), "code": z.any().describe("AIP-26 CODE block. Optional — when present, the workspace IS a code-workspace / repo (codespace pattern).").optional(), "identity": z.any().describe("AIP-23 identity-ref — default identity for sub-blocks. Sub-blocks (storage, sandbox, code) may override.").optional(), "defaults": z.object({ "read_only": z.boolean().optional() }).catchall(z.any()).optional(), "publish": z.object({ "template": z.boolean().default(false), "registry": z.string().optional(), "visibility": z.enum(["private","unlisted","public"]).default("private") }).strict().optional(), "tags": z.array(z.string()).default([] as never), "created_at": z.string().datetime({ offset: true }).optional(), "metadata": z.record(z.string(), z.any()).optional() }).strict().describe("Validates the YAML frontmatter portion of an AIP-34 WORKSPACE.md manifest. Composes the AIP-35 STORAGE block (required), AIP-36 SANDBOX block (optional), AIP-26 CODE block (optional), AIP-23 identity-ref block (optional).")

export type WorkspaceFrontmatter = z.infer<typeof workspaceFrontmatterSchema>
