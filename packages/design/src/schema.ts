/**
 * AIP-4 DESIGN.md frontmatter zod schema.
 *
 * Generated from `resources/aip-4/draft/DESIGN.schema.json` via
 * json-schema-to-zod. Imported by both `define-design.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-design.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const designFrontmatterSchema = z.object({ "schema": z.literal("designkit/v1").describe("Pins the registry schema this kit conforms to. Required for registry submission.").optional(), "kit": z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$")).min(2).max(48).describe("Kebab-case kit identifier. Namespaced by the registry on publish."), "title": z.string().min(1).max(80).describe("Human-readable display name."), "description": z.string().max(500).describe("One-paragraph summary surfaced in registry search results.").optional(), "version": z.string().regex(new RegExp("^\\d+\\.\\d+\\.\\d+(?:[-+][a-zA-Z0-9.-]+)?$")).describe("Semver of THIS kit. Bump on token change.").optional(), "author": z.string().describe("Display name of the author / maintainer.").optional(), "license": z.string().describe("SPDX identifier or 'proprietary' for private brand kits.").optional(), "homepage": z.string().url().optional(), "preview": z.string().url().describe("URL to a screenshot of the kit applied to a reference surface.").optional(), "tags": z.array(z.string().regex(new RegExp("^[a-z][a-z0-9-]*$"))).min(0).max(12).default([] as never), "based-on": z.string().describe("URI of a parent DESIGN.md to compose on top of. Depth-limited to 3.").optional(), "mode": z.enum(["light","dark","both"]).describe("Default surface mode. 'both' requires a sibling 'variants' block.").default("light"), "colors": z.any(), "typography": z.any(), "spacing": z.any().optional(), "rounded": z.any().optional(), "shadows": z.any().optional(), "motion": z.object({ "duration": z.any().optional(), "easing": z.any().optional() }).strict().optional(), "variants": z.object({ "dark": z.any().optional(), "light": z.any().optional() }).strict().describe("Delta blocks per mode. Only tokens that differ from the base are listed.").optional(), "metadata": z.record(z.string(), z.any()).describe("Host-namespaced extension fields. Other hosts MUST tolerate unknown keys here.").default({} as never) }).strict().and(z.any()).describe("Validates the YAML frontmatter portion of an AIP-4 DESIGN.md design-token kit.")

export type DesignFrontmatter = z.infer<typeof designFrontmatterSchema>
