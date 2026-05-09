/**
 * @agentproto/storage — AIP-35 STORAGE.md `defineStorage` reference impl.
 *
 * A composable schema block defining the `storage` field — provider, config, sync semantics, auth ref, exclude rules — for any manifest that names a backing store. Reused by WORKSPACE.md (AIP-34) and any future manifest that names persistent state. Inline or ref, mirroring AIP-17 RUNNER and AIP-19 SECRETS.
 *
 * Spec: https://agentproto.sh/docs/aip-35
 *
 * Authoring paths:
 *   - TS:  `defineStorage({...})` → `StorageHandle`
 *   - MD:  `parseStorageManifest(src) → storageFromManifest({...})` → `StorageHandle`
 */

export const SPEC_NAME = "agentstorage/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineStorage } from "./define-storage.js"
export type {
  StorageDefinition,
  StorageHandle,
  StorageRuntimeInput,
  StorageRuntimeHandle,
} from "./types.js"
