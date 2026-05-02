/**
 * @agentproto/io — AIP-16 IO.md `defineIo` reference impl.
 *
 * A composable schema block defining `inputs`, `outputs`, `inputsFiles`, and `outputsFiles` — the data-shape primitives reused by every manifest format that needs to declare what flows in and out of a runnable unit.
 *
 * Spec: https://agentproto.sh/docs/aip-16
 *
 * Authoring paths:
 *   - TS:  `defineIo({...})` → `IoHandle`
 *   - MD:  `parseIoManifest(src) → ioFromManifest({...})` → `IoHandle`
 */

export const SPEC_NAME = "agentio/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineIo } from "./define-io.js"
export type { IoDefinition, IoHandle } from "./types.js"
