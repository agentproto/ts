/**
 * AIP-5 TEMPLATE.md frontmatter zod schema.
 *
 * Generated from `resources/aip-5/draft/TEMPLATE.schema.json` via
 * json-schema-to-zod. Imported by both `define-canvakit.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-canvakit.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const canvakitFrontmatterSchema = z.object({ "schema": z.literal("canvakit/v1").describe("Spec version pin. Hosts that find an unknown schema MUST refuse rather than guess.").optional(), "template": z.literal(true).describe("Required marker. Tooling that loads files by glob uses this to catch 'renamed but not a template' mistakes."), "name": z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$")).min(2).max(64).describe("Slug-safe machine name. Lowercase, digits, dashes."), "version": z.string().regex(new RegExp("^\\d+\\.\\d+\\.\\d+(?:[-+][a-zA-Z0-9.-]+)?$")).describe("Semver. Bump on breaking change to the rendered shape or variables contract."), "description": z.string().max(2000).describe("One-sentence purpose for the gallery card.").optional(), "author": z.string().describe("Optional locally; required for gallery publish — (author, name, version) is the canonical key.").optional(), "renderer": z.enum(["mustache","handlebars","mdx"]).describe("Template engine. v1 default 'mustache' is universally supported; others are spec-legal but optional.").default("mustache"), "design": z.string().describe("Designkit fallback hint. Used only when no workspace design is active. Schemes: dk:<preset>, ws:<path>, kit:<slug>, or a bare *.md path.").optional(), "forceDesign": z.string().describe("Designkit override. Bypasses workspace selection. Same scheme grammar as 'design'.").optional(), "refreshEvery": z.union([z.enum(["manual","on-tool-change"]), z.string().regex(new RegExp("^\\d+(ms|s|m|h)$")).describe("Duration string — e.g. 60s, 5m, 1h.")]).describe("Declarative cadence hint. Honored opportunistically; runtimes that can't honor SHOULD treat as 'manual'.").default("manual"), "variables": z.record(z.string(), z.any()).describe("Caller inputs with author defaults. Substituted into sources params before resolution.").default({} as never), "sources": z.record(z.string(), z.any()).describe("Named data sources resolved in parallel and merged into the render context.").default({} as never), "imports": z.record(z.string(), z.any()).describe("Nested canvases. Each renders in isolation; output exposed under {{{imports.<name>}}}.").default({} as never), "tags": z.array(z.string().regex(new RegExp("^[a-z][a-z0-9-]*$"))).default([] as never), "metadata": z.record(z.string(), z.any()).describe("Host-specific extension surface. Other hosts MUST tolerate unknown metadata.<host>.* keys.").default({} as never) }).describe("Validates the YAML frontmatter portion of an AIP-5 *.canvakit.* template.")

export type CanvakitFrontmatter = z.infer<typeof canvakitFrontmatterSchema>
