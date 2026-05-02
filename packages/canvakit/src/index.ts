/**
 * @agentproto/canvakit — AIP-5 TEMPLATE.md `defineCanvakit` reference impl.
 *
 * A markdown + frontmatter format for templates that declare named data sources, resolve them in parallel, and re-render when data changes.
 *
 * Spec: https://agentproto.sh/docs/aip-5
 *
 * Authoring paths:
 *   - TS:  `defineCanvakit({...})` → `CanvakitHandle`
 *   - MD:  `parseCanvakitManifest(src) → canvakitFromManifest({...})` → `CanvakitHandle`
 */

export const SPEC_NAME = "agentcanvakit/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineCanvakit } from "./define-canvakit.js"
export type { CanvakitDefinition, CanvakitHandle } from "./types.js"
