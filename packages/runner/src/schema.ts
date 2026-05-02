/**
 * AIP-17 RUNNER.md frontmatter zod schema.
 *
 * Generated from `resources/aip-17/draft/RUNNER.schema.json` via
 * json-schema-to-zod. Imported by both `define-runner.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-runner.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const runnerFrontmatterSchema = z.record(z.string(), z.any()).describe("Composable JSON Schema definition for the `runner` block — process boundary, optional container image, declarative dependency needs, and resource limits. Other AIPs reference this by $ref into their own schemas.")

export type RunnerFrontmatter = z.infer<typeof runnerFrontmatterSchema>
