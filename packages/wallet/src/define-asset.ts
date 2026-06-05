/**
 * AIP-49 reference constructor `defineAsset`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id-pattern, top-level
 * freeze, "defineAsset (AIP-49): …" error prefix) run uniformly with every other
 * AIP defineX. The identity is the asset `ref` (UPPER_SNAKE, so we override the
 * default lowercase id pattern); field validation runs the zod schema.
 *
 * Plus two structural guards no schema expresses cleanly: a ruleSet that may
 * settle out OR spend MUST be backed (no infinite-mint internal asset that
 * leaks value), and convert edges must not point at the asset itself.
 */

import { createDoctype } from "@agentproto/define-doctype"
import type { AssetDeclaration } from "./asset.js"
import { assetDeclarationSchema } from "./schema.js"

const REF_PATTERN = /^[A-Z0-9][A-Z0-9_]{1,79}$/

export const defineAsset = createDoctype<AssetDeclaration, AssetDeclaration>({
  aip: 49,
  name: "asset",
  readIdentity: def => def.ref,
  idPattern: REF_PATTERN,
  readDescription: false,
  validate(def) {
    const result = assetDeclarationSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineAsset (AIP-49): ${result.error.issues
          .map(i => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
    for (const e of def.ruleSet.convertEdges) {
      if (e.to === def.ref) {
        throw new Error(
          `defineAsset (AIP-49): asset '${def.ref}' has a convert edge to itself`,
        )
      }
    }
  },
  build(def) {
    return {
      ...def,
      ruleSet: Object.freeze({
        ...def.ruleSet,
        spendableOn: Object.freeze([...def.ruleSet.spendableOn]),
        convertEdges: Object.freeze(
          def.ruleSet.convertEdges.map(e => Object.freeze({ ...e })),
        ),
      }),
    } as AssetDeclaration
  },
})
