/**
 * Legacy `targets[]` / `binds_operator` → Selector compile.
 *
 * Permanent, not transitional: PLAYBOOK.md files authored before
 * `selector:` live in real corpus workspaces and keep working forever.
 *
 * The legacy format is axis-AMBIGUOUS: a `kind: "operator"` ref (and
 * `binds_operator`) historically held either an operator slug OR a
 * role slug — the old matcher tried both. The compile preserves that
 * exactly by putting each such ref in BOTH the identity and the role
 * bucket of an `anyOf` selector. `kind: "role" | "skill" | "runtime"`
 * refs compile to their own axes (a host that supplies no `skill`
 * dimension keeps today's no-match behavior for skill targets).
 */

import {
  capabilityAxis,
  identityAxis,
  positionAxis,
  roleAxis,
  prefixedRefNormalizer,
} from "./axes.js"
import type { Selector, SelectorTerm } from "./selector.js"

interface LegacyTarget {
  readonly kind: string
  readonly ref: string
}

const normalizeOperatorRef = identityAxis.normalizeRef!
const normalizeRoleRef = roleAxis.normalizeRef!
const normalizeSkillRef = prefixedRefNormalizer("skill", "skills")
const normalizeRuntimeRef = prefixedRefNormalizer("runtime", "runtimes")

export function compileLegacyPlaybookBinding(
  targets: readonly LegacyTarget[],
  bindsOperator?: string
): Selector {
  const identity = new Set<string>()
  const role = new Set<string>()
  const skill = new Set<string>()
  const runtime = new Set<string>()

  if (bindsOperator) {
    identity.add(normalizeOperatorRef(bindsOperator))
    role.add(normalizeRoleRef(bindsOperator))
  }
  for (const target of targets) {
    switch (target.kind) {
      case "operator":
        identity.add(normalizeOperatorRef(target.ref))
        role.add(normalizeRoleRef(target.ref))
        break
      case "role":
        role.add(normalizeRoleRef(target.ref))
        break
      case "skill":
        skill.add(normalizeSkillRef(target.ref))
        break
      case "runtime":
        runtime.add(normalizeRuntimeRef(target.ref))
        break
      default:
        break
    }
  }

  const anyOf: SelectorTerm[] = []
  pushTerm(anyOf, identityAxis.id, identity)
  pushTerm(anyOf, roleAxis.id, role)
  pushTerm(anyOf, "skill", skill)
  pushTerm(anyOf, "runtime", runtime)
  if (!anyOf.length) return Object.freeze({})
  return Object.freeze({ anyOf: Object.freeze(anyOf) })
}

function pushTerm(out: SelectorTerm[], axis: string, refs: Set<string>): void {
  if (!refs.size) return
  out.push(Object.freeze({ axis, anyOf: Object.freeze([...refs]) }))
}

// Re-exported so hosts assembling Dimensions use the same axis ids the
// compile emits.
export { identityAxis, roleAxis, positionAxis, capabilityAxis }
