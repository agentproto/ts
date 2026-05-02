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

export const companyFrontmatterSchema = z.object({ "schema": z.literal("agentcompanies/v1").describe("Format identifier. MUST be the literal string `agentcompanies/v1`."), "doctype": z.enum(["company","role","objective"]).describe("Discriminator. Selects the doctype-specific branch under `oneOf`."), "id": z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$")).min(2).max(64).describe("Slug identifier. Lowercase, digits, dashes. Stable across renames; references use this, never database IDs."), "version": z.string().regex(new RegExp("^\\d+\\.\\d+\\.\\d+(?:[-+][a-zA-Z0-9.-]+)?$")).describe("Spec version of THIS file. Bump on breaking change.").optional(), "name": z.string().min(1).max(200).describe("Human-readable display name.").optional(), "description": z.string().max(2000).describe("One-paragraph purpose.").optional(), "tags": z.array(z.string().regex(new RegExp("^[a-z][a-z0-9-]*$"))).default([] as never), "metadata": z.record(z.string(), z.any()).describe("Vendor-specific extensions. Authors stash hints under namespaced keys `metadata.<vendor>.…`; other readers MUST tolerate unknown keys.").default({} as never) }).and(z.any().superRefine((x, ctx) => {
    const schemas = [z.any(), z.any(), z.any()];
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
  })).describe("Validates the YAML frontmatter portion of any agentcompanies/v1 doctype file. The `doctype` field discriminates between company / role / objective; each branch enforces the doctype-specific shape. Operator doctype is sketched here but the normative definition lives in AIP-8 — only company / role / objective are normative under AIP-6.")

export type CompanyFrontmatter = z.infer<typeof companyFrontmatterSchema>
