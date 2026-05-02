import { createDoctype } from "@agentproto/define-doctype"
import type { OperatorDefinition, OperatorHandle } from "./types.js"

/**
 * AIP-9 reference implementation of `defineOperator`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineOperator (AIP-9): …"
 * error prefix) run uniformly with every other AIP defineX. Spec-9-
 * specific validation goes in `validate(def)`; defaulting and nested
 * freezing in `build(def)`.
 */
export const defineOperator = createDoctype<OperatorDefinition, OperatorHandle>({
  aip: 9,
  name: "operator",
  validate(_def) {
    // TODO: spec-9-specific checks.
  },
  build(def) {
    return {
      id: def.id,
      description: def.description,
      // TODO: defaulting + nested freezing.
    }
  },
})
