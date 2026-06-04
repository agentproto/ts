/**
 * @agentproto/policy — AIP-38 POLICY.md `definePolicy` reference impl.
 *
 * A markdown + frontmatter format for declaring policy on a resource — access grants (who can perform which actions), defaults (per-block behavioural defaults), limits (rate / quota caps), and requirements (cross-cutting must-haves like MFA / approval). Composable inline | ref | file. Granted on AIP-39 ACTION ids — implementations / TOOLs are decoupled from policy.
 *
 * Spec: https://agentproto.sh/docs/aip-38
 *
 * Authoring paths:
 *   - TS:  `definePolicy({...})` → `PolicyHandle`
 *   - MD:  `parsePolicyManifest(src) → policyFromManifest({...})` → `PolicyHandle`
 */

export const SPEC_NAME = "agentpolicy/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { definePolicy } from "./define-policy.js"
export { policyFrontmatterSchema } from "./schema.js"
export type { PolicyFrontmatter } from "./schema.js"
export type { PolicyDefinition, PolicyHandle } from "./types.js"
