/**
 * @agentproto/pack — PACK.md `definePack` reference impl.
 *
 * A bundle that assembles a plugin (inline skills or a merge of
 * published skill packs), apps, a knowledge workspace selection, and an
 * optional playbook to generate — plus pricing and non-technical blockers.
 *
 * No AIP is assigned to PACK.md yet — this is not AIP-52 (that's
 * ADAPTER — agentadapter/v1, implemented by @agentproto/mastra). PACK
 * has no spec draft in agentproto/agentproto today.
 *
 * Authoring paths:
 *   - TS:  `definePack({...})` → `PackHandle`
 *   - MD:  `parsePackManifest(src) → packFromManifest({...})` → `PackHandle`
 */

export { definePack } from "./define-pack.js"
export type { PackDefinition, PackHandle, PackStatus } from "./types.js"
export { packFrontmatterSchema, type PackFrontmatter } from "./schema.js"
export {
  parsePackManifest,
  packFromManifest,
  type PackManifest,
} from "./manifest/index.js"