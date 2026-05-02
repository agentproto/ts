/**
 * @agentproto/persona — AIP-25 PERSONA.md `definePersona` reference impl.
 *
 * A single-doc markdown + frontmatter format for portable agent personas — the public face, voice register, backstory, and boundaries of a character — sibling to AIP-23 IDENTITY (heavy substance) and building block of AIP-24 ASSEMBLY.
 *
 * Spec: https://agentproto.sh/docs/aip-25
 *
 * Authoring paths:
 *   - TS:  `definePersona({...})` → `PersonaHandle`
 *   - MD:  `parsePersonaManifest(src) → personaFromManifest({...})` → `PersonaHandle`
 */

export const SPEC_NAME = "agentpersona/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { definePersona } from "./define-persona.js"
export type { PersonaDefinition, PersonaHandle } from "./types.js"
