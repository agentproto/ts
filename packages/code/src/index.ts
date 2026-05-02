/**
 * @agentproto/code — AIP-26 CODE.md `defineCode` reference impl.
 *
 * A composable schema block defining the `code` and `run` fields that declare what files compose a runnable bundle (inline, local, github, ref) and how to invoke them — together with the `code-workspace` first-class kind that other manifests reference.
 *
 * Spec: https://agentproto.sh/docs/aip-26
 *
 * Authoring paths:
 *   - TS:  `defineCode({...})` → `CodeHandle`
 *   - MD:  `parseCodeManifest(src) → codeFromManifest({...})` → `CodeHandle`
 */

export const SPEC_NAME = "agentcode/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineCode } from "./define-code.js"
export type { CodeDefinition, CodeHandle } from "./types.js"
