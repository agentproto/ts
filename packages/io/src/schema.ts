/**
 * AIP-16 IO.md frontmatter zod schema.
 *
 * Generated from `resources/aip-16/draft/IO.schema.json` via
 * json-schema-to-zod. Imported by both `define-io.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-io.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const ioFrontmatterSchema = z.record(z.string(), z.any()).describe("Composable JSON Schema definitions for the four input/output blocks reused across manifest formats: inputs, outputs, inputsFiles, outputsFiles. Other AIPs reference these by $ref into their own schemas.")

export type IoFrontmatter = z.infer<typeof ioFrontmatterSchema>
