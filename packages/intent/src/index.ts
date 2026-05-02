/**
 * @agentproto/intent — AIP-28 INTENT.md `defineIntent` reference impl.
 *
 * A markdown + frontmatter format for declaring a user-facing agent intent — the verb a user surfaces ("create image", "list PRs"). Sits between SKILL (multi-step expertise) and TOOL (atomic technical call), carrying the catalog/UX layer (label, intent, surfaces, examples) and routing one or more underlying tools, with the standard `defineIntent` entry-point signature.
 *
 * Spec: https://agentproto.sh/docs/aip-28
 *
 * Authoring paths:
 *   - TS:  `defineIntent({...})` → `IntentHandle`
 *   - MD:  `parseIntentManifest(src) → intentFromManifest({...})` → `IntentHandle`
 */

export const SPEC_NAME = "agentintent/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineIntent } from "./define-intent.js"
export type { IntentDefinition, IntentHandle } from "./types.js"
