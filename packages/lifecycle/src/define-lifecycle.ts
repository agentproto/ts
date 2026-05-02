import { createDoctype } from "@agentproto/define-doctype"
import type { LifecycleDefinition, LifecycleHandle } from "./types.js"

/**
 * AIP-37 reference implementation of `defineLifecycle`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineLifecycle (AIP-37): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Spec-37-specific validation goes in `validate(def)`; defaulting
 * and nested freezing in `build(def)`.
 */
export const defineLifecycle = createDoctype<LifecycleDefinition, LifecycleHandle>({
  aip: 37,
  name: "lifecycle",
  validate(_def) {
    // TODO: spec-37-specific checks.
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as LifecycleHandle
  },
})
