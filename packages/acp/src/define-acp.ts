import { createDoctype } from "@agentproto/define-doctype"
import { acpFrontmatterSchema } from "./schema.js"
import type { AcpDefinition, AcpHandle } from "./types.js"

/**
 * AIP-44 reference implementation of `defineAcp`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineAcp (AIP-44): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts`. Same source of truth as the .md path uses
 * (`parseAcpManifest`), so a malformed TS-authored definition fails
 * with the same diagnostic as a malformed manifest.
 *
 * Cross-field rules (kind=server requires `metadata.aip44.operator`;
 * tier=sandboxed requires `metadata.aip44.sandbox`) run after the
 * zod check so callers see one consistent error path.
 */
export const defineAcp = createDoctype<AcpDefinition, AcpHandle>({
  aip: 44,
  name: "acp",
  readIdentity: (def) => def.id,
  validate(def) {
    const result = acpFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineAcp (AIP-44): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }

    const aip44 = result.data.metadata.aip44

    if (result.data.kind === "server" && !aip44.operator) {
      throw new Error(
        "defineAcp (AIP-44): metadata.aip44.operator is required when kind=server",
      )
    }

    if (aip44.tier === "sandboxed" && !aip44.sandbox) {
      throw new Error(
        "defineAcp (AIP-44): metadata.aip44.sandbox is required when metadata.aip44.tier=sandboxed",
      )
    }
  },
  build(def) {
    return { ...def } as AcpHandle
  },
})
