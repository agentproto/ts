/**
 * @agentproto/lifecycle — AIP-37 LIFECYCLE.md `defineLifecycle` reference impl.
 *
 * A vocabulary AIP defining the standard lifecycle event names that hosts fire and that policy blocks (storage sync, sandbox lifecycle, etc.) reference. Not a runtime — just a shared language so configs across hosts mean the same thing.
 *
 * Spec: https://agentproto.sh/docs/aip-37
 *
 * Authoring paths:
 *   - TS:  `defineLifecycle({...})` → `LifecycleHandle`
 *   - MD:  `parseLifecycleManifest(src) → lifecycleFromManifest({...})` → `LifecycleHandle`
 */

export const SPEC_NAME = "agentlifecycle/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineLifecycle } from "./define-lifecycle.js"
export type { LifecycleDefinition, LifecycleHandle } from "./types.js"
