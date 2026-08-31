/**
 * @agentproto/pack — AIP-52 PACK.md `definePack` reference impl.
 *
 * A bundle that assembles a plugin (inline skills or a merge of
 * published skill packs), apps, a knowledge workspace selection, and an
 * optional playbook to generate — plus pricing and non-technical blockers.
 *
 * Spec: https://agentproto.sh/docs/aip-52
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