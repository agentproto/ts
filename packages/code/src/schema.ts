/**
 * AIP-26 CODE.md frontmatter zod schema.
 *
 * Generated from `resources/aip-26/draft/CODE.schema.json` via
 * json-schema-to-zod. Imported by both `define-code.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-code.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const codeFrontmatterSchema = z.record(z.string(), z.any()).describe("Composable JSON Schema definitions for the `code` and `run` blocks reused across manifest formats. Other AIPs reference these by $ref into their own schemas.")

export type CodeFrontmatter = z.infer<typeof codeFrontmatterSchema>
