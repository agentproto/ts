/**
 * @agentproto/pack — PACK.md `definePack` reference impl.
 *
 * A bundle that assembles a plugin (inline skills or a merge of
 * published skill packs), apps, a knowledge workspace selection, and an
 * optional playbook to generate — plus pricing and non-technical blockers.
 *
 * Spec: AIP-64 (PACK.md, pack/v1) — specs/aip-64.mdx in
 * agentproto/agentproto. Note: AIP-52 is ADAPTER (agentadapter/v1,
 * implemented by @agentproto/mastra), a different thing entirely; the
 * error prefix briefly read "AIP-52" before the spec was written.
 *
 * Authoring paths:
 *   - TS:  `definePack({...})` → `PackHandle`
 *   - MD:  `parsePackManifest(src) → packFromManifest({...})` → `PackHandle`
 */

/** AIP-70 registry spec id for this package (`pack/v1`, AIP-64). */
export const SPEC_NAME = "pack/v1" as const

export { definePack } from "./define-pack.js"
export type { PackDefinition, PackHandle, PackStatus } from "./types.js"
export { packFrontmatterSchema, type PackFrontmatter } from "./schema.js"
export {
  parsePackManifest,
  packFromManifest,
  type PackManifest,
} from "./manifest/index.js"