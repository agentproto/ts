/**
 * AIP-19 SECRETS.md frontmatter zod schema.
 *
 * Generated from `resources/aip-19/draft/SECRETS.schema.json` via
 * json-schema-to-zod. Imported by both `define-secrets.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-secrets.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const secretsFrontmatterSchema = z.object({ "secrets": z.array(z.any()).min(1) }).strict().describe("Validates the YAML frontmatter portion of an AIP-19 SECRETS.md manifest. The manifest declares secret slugs + access policy + audit metadata. Values are NEVER stored in the manifest.")

export type SecretsFrontmatter = z.infer<typeof secretsFrontmatterSchema>
