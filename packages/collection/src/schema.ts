/**
 * AIP-18 COLLECTION.md frontmatter zod schema.
 *
 * Generated from `resources/aip-18/draft/COLLECTION.schema.json` via
 * json-schema-to-zod. Imported by both `define-collection.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-collection.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const collectionFrontmatterSchema = z.any().superRefine((x, ctx) => {
    const schemas = [z.any(), z.any()];
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
  }).describe("Validates the YAML frontmatter portion of an AIP-18 collection schema or item. The doctype is selected via the `schema` discriminator: 'collection.schema/v1' (a COLLECTION.md, the schema for a class of records) or 'collection.item/v1' (an instance of one record validated against a named collection).")

export type CollectionFrontmatter = z.infer<typeof collectionFrontmatterSchema>
