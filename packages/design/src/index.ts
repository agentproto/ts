/**
 * @agentproto/design — AIP-4 DESIGN.md `defineDesign` reference impl.
 *
 * A markdown + frontmatter format for portable design tokens, and the registry conventions used by designkit.sh to share community kits.
 *
 * Spec: https://agentproto.sh/docs/aip-4
 *
 * Authoring paths:
 *   - TS:  `defineDesign({...})` → `DesignHandle`
 *   - MD:  `parseDesignManifest(src) → designFromManifest({...})` → `DesignHandle`
 */

export const SPEC_NAME = "agentdesign/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineDesign } from "./define-design.js"
export type { DesignDefinition, DesignHandle } from "./types.js"
