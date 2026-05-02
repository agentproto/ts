import { createDoctype } from "@agentproto/define-doctype"
import type { StorageDefinition, StorageHandle } from "./types.js"

/**
 * AIP-35 reference implementation of `defineStorage`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineStorage (AIP-35): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Spec-35-specific validation goes in `validate(def)`; defaulting
 * and nested freezing in `build(def)`.
 */
export const defineStorage = createDoctype<StorageDefinition, StorageHandle>({
  aip: 35,
  name: "storage",
  validate(_def) {
    // TODO: spec-35-specific checks.
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as StorageHandle
  },
})
