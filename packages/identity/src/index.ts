/**
 * @agentproto/identity — AIP-23 IDENTITY.md `defineIdentity` reference impl.
 *
 * A workspace AIP that defines layered, composable agent identity — typed layers as AIP-18 collections, confidence-scored items, optional temporal entries, and compression-artifact tiers — owning only the workspace root manifest, layer registry, compression policy, junction rules, and cross-AIP composition.
 *
 * Spec: https://agentproto.sh/docs/aip-23
 *
 * Authoring paths:
 *   - TS:  `defineIdentity({...})` → `IdentityHandle`
 *   - MD:  `parseIdentityManifest(src) → identityFromManifest({...})` → `IdentityHandle`
 */

export const SPEC_NAME = "agentidentity/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineIdentity } from "./define-identity.js"
export type { IdentityDefinition, IdentityHandle } from "./types.js"
