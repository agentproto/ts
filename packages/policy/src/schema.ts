/**
 * AIP-38 POLICY.md frontmatter zod schema.
 *
 * Generated from `resources/aip-38/draft/POLICY.schema.json` via
 * json-schema-to-zod. Imported by both `define-policy.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-policy.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const policyFrontmatterSchema = z.object({ "schema": z.literal("policy/v1"), "id": z.string().regex(new RegExp("^@[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$")).describe("Standalone-only. Globally addressable id `@<owner-slug>/<policy-slug>`.").optional(), "version": z.string().regex(new RegExp("^\\d+\\.\\d+\\.\\d+(?:[-+][\\w.\\-]+)?$")).describe("Standalone-only. Spec version of THIS file.").optional(), "default": z.enum(["allow","deny"]).describe("Default decision when no grant matches. `deny` strongly recommended; `allow` is audit-significant.").default("deny"), "grants": z.array(z.any()).describe("Access grants. Each grant ties a principal (AIP-23) to a set of actions (AIP-39).").default([] as never), "defaults": z.record(z.string(), z.record(z.string(), z.any())).describe("Per-block behavioural defaults. Keys are AIP block names (storage, sandbox, code, secrets); values are partial block configs.").default({} as never), "limits": z.array(z.any()).describe("Resource limits. Each `{ kind, value, scope?, per?, applies_to? }`.").default([] as never), "requirements": z.array(z.any()).describe("Cross-cutting must-haves (MFA, signing, approvals). ANDed across composed policies.").default([] as never), "metadata": z.record(z.string(), z.any()).describe("Free-form, namespaced.").optional() }).strict().describe("Validates the YAML frontmatter portion of an AIP-38 POLICY.md manifest, OR the inline form embedded in any other manifest's `policy:` block. Grants on AIP-39 ACTION ids; principals via AIP-23 identity-ref schemes.")

export type PolicyFrontmatter = z.infer<typeof policyFrontmatterSchema>
