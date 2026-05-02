import { createDoctype } from "@agentproto/define-doctype"
import type { SandboxDefinition, SandboxHandle } from "./types.js"

/**
 * AIP-36 reference implementation of `defineSandbox`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineSandbox (AIP-36): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Spec-36-specific validation goes in `validate(def)`; defaulting
 * and nested freezing in `build(def)`.
 */
export const defineSandbox = createDoctype<SandboxDefinition, SandboxHandle>({
  aip: 36,
  name: "sandbox",
  validate(_def) {
    // TODO: spec-36-specific checks.
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as SandboxHandle
  },
})
