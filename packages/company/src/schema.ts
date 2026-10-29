/**
 * AIP-6 COMPANY.md frontmatter zod schema.
 *
 * Generated from `resources/aip-6/draft/COMPANY.schema.json` via
 * json-schema-to-zod. Imported by both `define-company.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-company.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const companyFrontmatterSchema = z.object({ "schema": z.enum(["company/v1","agentcompanies/v1"]).describe("Format identifier. Writers MUST emit the canonical string `company/v1`. `agentcompanies/v1` is accepted as a legacy alias (AIP-70)."), "doctype": z.enum(["company","objective","agent"]).describe("Canonical discriminator. Selects the doctype-specific branch under `oneOf`. `agent` is the legacy AIP-6 agent slot marker (see AIP-42 Backward compatibility); the shape of an agent file is AIP-42's, not this schema's. A file MUST carry `doctype` or its alias `kind`.").optional(), "kind": z.enum(["company","objective","agent"]).describe("Alias of `doctype`, accepted permanently with no removal date. When a file carries both, they MUST name the same doctype.").optional(), "id": z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$")).min(2).max(64).describe("Canonical slug identifier. Lowercase, digits, dashes. Stable across renames; references use this, never database IDs. A file MUST carry `id` or its alias `slug`.").optional(), "slug": z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$")).min(2).max(64).describe("Alias of `id`, accepted permanently with no removal date. When a file carries both, they MUST be equal; a JSON Schema cannot compare two values, so a host reports `alias_conflict` itself (ADAPTER.md).").optional(), "version": z.string().regex(new RegExp("^\\d+\\.\\d+\\.\\d+(?:[-+][a-zA-Z0-9.-]+)?$")).describe("Spec version of THIS file. Bump on breaking change.").optional(), "name": z.string().min(1).max(200).describe("Human-readable display name.").optional(), "description": z.string().max(2000).describe("One-paragraph purpose.").optional(), "tags": z.array(z.string().regex(new RegExp("^[a-z][a-z0-9-]*$"))).default([] as never), "metadata": z.record(z.string(), z.any()).describe("Vendor-specific extensions. Authors stash hints under namespaced keys `metadata.<vendor>.…`; other readers MUST tolerate unknown keys.").default({} as never) }).and(z.any().superRefine((x, ctx) => {
    const schemas = [z.object({ "mission": z.string().min(1).max(1000).describe("One-paragraph mission. Read by every operator at boot."), "values": z.array(z.string().max(200)).describe("Short value statements; surfaced in role prompts.").default([] as never), "structure": z.object({ "positions": z.array(z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$"))).describe("DEPRECATED: seats live in the AIP-22 office (AIP-22 An office spans a company tree). Slugs of the company's seats. Readers MUST keep accepting it, with no removal date; when the company has an office, the office is authoritative and this list is only a seed. A position is a seat one operator holds; several positions may share one AIP-47 catalog role.").default([] as never), "roles": z.array(z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$"))).describe("DEPRECATED alias of `positions`, itself deprecated toward the AIP-22 office. Readers MUST accept it, with no removal date; when both are present, `positions` wins. Historically documented as role slugs but used in practice for seats.").default([] as never), "objectives": z.array(z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$"))).describe("Slugs of top-level objectives defined under `objectives/<slug>/OBJECTIVE.md`.").default([] as never), "reports_to": z.record(z.string(), z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$"))).describe("DEPRECATED: reporting lines live in the AIP-22 office (a seat's `reportsTo`). Map of position-slug to position-slug; the key reports to the value. Readers MUST keep accepting it, with no removal date; the office wins when both exist.").default({} as never) }).strict().optional(), "imports": z.array(z.object({ "from": z.string().describe("Source ref. Format: `<registry>/<package>@<version>` or a relative path."), "as": z.enum(["role","objective"]).describe("Imported doctype. A role is materialised as an AIP-47 `role/v1` document, an objective as a company/v1 objective."), "id": z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$")).describe("Local slug to bind the import under.").optional(), "alias": z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$")).describe("Override the import's local slug if it would collide.").optional() }).strict()).describe("External roles or objectives pulled from a registry. Resolved by the adapter at load time. An imported role is materialised as an AIP-47 `role/v1` document.").default([] as never) }).and(z.union([z.object({ "doctype": z.literal("company") }), z.object({ "kind": z.literal("company") })])), z.object({ "statement": z.string().min(1).max(2000).describe("One-paragraph statement of the desired outcome."), "owner": z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$")).describe("Slug of the position (an AIP-22 office seat) or of the AIP-47 role accountable for this objective.").optional(), "horizon": z.enum(["sprint","quarter","year","ongoing"]).describe("Time horizon. Adapter MAY use this to surface stale objectives.").default("quarter"), "status": z.enum(["proposed","active","paused","achieved","abandoned"]).default("active"), "key_results": z.array(z.object({ "id": z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$")), "statement": z.string().max(500), "target": z.string().max(200).optional(), "progress": z.number().gte(0).lte(1).optional() }).strict()).default([] as never), "parent": z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$")).describe("Slug of the parent objective (for decomposition trees). Omit for top-level objectives.").optional(), "children": z.array(z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$"))).describe("Slugs of child sub-objectives. Adapter validates the parent/children edges agree.").default([] as never), "depends_on": z.array(z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$"))).describe("Slugs of objectives this one depends on.").default([] as never) }).and(z.union([z.object({ "doctype": z.literal("objective") }), z.object({ "kind": z.literal("objective") })])), z.record(z.string(), z.any()).and(z.union([z.object({ "doctype": z.literal("agent") }), z.object({ "kind": z.literal("agent") })])).describe("Legacy AIP-6 agent slot (`agents/<id>/AGENT.md` with `schema: company/v1` and `kind: agent`). Only the marker is checked here: the field set of an agent is AIP-42's, and hosts read the file as an AGENT.md (`slug` is its `id`). AIP-42 sets no removal date for this form.")];
    const { errors, failed } = schemas.reduce<{
      errors: z.core.$ZodIssue[];
      failed: number;
    }>(
      ({ errors, failed }, schema) =>
        ((result) =>
          result.error
            ? {
                errors: [...errors, ...result.error.issues],
                failed: failed + 1,
              }
            : { errors, failed })(
          schema.safeParse(x),
        ),
      { errors: [], failed: 0 },
    );
    const passed = schemas.length - failed;
    if (passed !== 1) {
      ctx.addIssue(errors.length ? {
        path: [],
        code: "invalid_union",
        errors: [errors],
        message: "Invalid input: Should pass single schema. Passed " + passed,
      } : {
        path: [],
        code: "custom",
        errors: [errors],
        message: "Invalid input: Should pass single schema. Passed " + passed,
      });
    }
  })).and(z.intersection(z.intersection(z.union([z.any(), z.any()]), z.any()), z.intersection(z.any(), z.any()))).describe("Validates the YAML frontmatter portion of a company/v1 doctype file. The discriminator is `doctype`, or its alias `kind`; the identifier is `id`, or its alias `slug`. Both aliases are accepted permanently (AIP-6 sets no removal date for them). Three doctypes are defined here: company, objective, and the legacy agent marker. A ROLE.md is an AIP-47 role/v1 document, an OPERATOR.md is AIP-9, an AGENT.md is AIP-42, and seats and reporting lines live in the AIP-22 office: none of these is validated by this schema.")

export type CompanyFrontmatter = z.infer<typeof companyFrontmatterSchema>
