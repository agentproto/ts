/**
 * AIP-28 INTENT.md frontmatter zod schema.
 *
 * Generated from `resources/aip-28/draft/INTENT.schema.json` via
 * json-schema-to-zod. Imported by both `define-intent.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-intent.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const intentFrontmatterSchema = z.object({ "name": z.any().describe("Internal display name."), "id": z.string().regex(new RegExp("^[a-z0-9][a-z0-9.\\-]{1,79}$")), "label": z.any().describe("User-facing button/menu label."), "description": z.any().describe("User-facing copy (≤500 chars per locale)."), "version": z.string().regex(new RegExp("^\\d+\\.\\d+\\.\\d+(?:[-+][\\w.\\-]+)?$")), "intent": z.any().superRefine((x, ctx) => {
    const schemas = [z.array(z.string()).min(1), z.record(z.string(), z.array(z.string()).min(1))];
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
  }).describe("Natural-language seeds an LLM matches against."), "surfaces": z.array(z.enum(["chat","menu","voice","shortcut","api"])).min(0).refine((arr) => arr.every((item, i) => arr.indexOf(item) == i), { message: "All items must be unique!" }), "inputs": z.array(z.any()).optional(), "outputs": z.any().optional(), "entry": z.string().describe("Workspace-relative path to a routing implementation.").optional(), "implements": z.array(z.any()).min(1), "cost_class": z.enum(["trivial","metered","expensive"]).optional(), "quota_key": z.string().regex(new RegExp("^[a-z0-9][a-z0-9.\\-]{1,127}$")).optional(), "requires": z.any().optional(), "auth": z.string().describe("Workspace-relative path to a SECRETS.md (AIP-19).").optional(), "experiments": z.array(z.any()).optional(), "preview": z.string().optional(), "tags": z.array(z.string().regex(new RegExp("^[a-z0-9][a-z0-9\\-]{0,63}$"))).refine((arr) => arr.every((item, i) => arr.indexOf(item) == i), { message: "All items must be unique!" }).optional(), "examples": z.array(z.object({ "user": z.any(), "note": z.any().optional() }).strict()).optional(), "metadata": z.record(z.string(), z.any()).optional() }).strict().describe("JSON Schema for the YAML frontmatter of an AIP-28 INTENT.md manifest.")

export type IntentFrontmatter = z.infer<typeof intentFrontmatterSchema>
