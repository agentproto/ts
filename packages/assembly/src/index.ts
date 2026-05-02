/**
 * @agentproto/assembly — AIP-24 ASSEMBLY.md `defineAssembly` reference impl.
 *
 * A workspace AIP for multi-agent collectives. Unifies four collaboration patterns — council (advisory overlay), voting (quorum decision body), peer (network of equals), and hierarchy (reporting tree) — under one doctype, with synthesis rules, locked traits, and audit policy as first-class workspace concerns.
 *
 * Spec: https://agentproto.sh/docs/aip-24
 *
 * Authoring paths:
 *   - TS:  `defineAssembly({...})` → `AssemblyHandle`
 *   - MD:  `parseAssemblyManifest(src) → assemblyFromManifest({...})` → `AssemblyHandle`
 */

export const SPEC_NAME = "agentassembly/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineAssembly } from "./define-assembly.js"
export type { AssemblyDefinition, AssemblyHandle } from "./types.js"
