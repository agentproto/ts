import { createDoctype } from "@agentproto/define-doctype"
import type { WorkspaceDefinition, WorkspaceHandle } from "./types.js"

/**
 * AIP-34 reference implementation of `defineWorkspace`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineWorkspace (AIP-34): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Spec-34-specific validation goes in `validate(def)`; defaulting
 * and nested freezing in `build(def)`.
 */
export const defineWorkspace = createDoctype<WorkspaceDefinition, WorkspaceHandle>({
  aip: 34,
  name: "workspace",
  validate(_def) {
    // TODO: spec-34-specific checks.
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as WorkspaceHandle
  },
})
