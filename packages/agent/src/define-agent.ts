import { createDoctype } from "@agentproto/doctype"
import { agentFrontmatterSchema } from "./schema.js"
import type { AgentDefinition, AgentHandle } from "./types.js"

/**
 * AIP-42 id pattern — the single source of truth for a valid agent id.
 *
 * Bare ids, or an `@<owner>/`-prefixed namespaced id (`@agentik/writer`).
 * Exported so callers that must resolve an id to a filesystem path (e.g.
 * `create_tool`'s grant check) can reject path-traversal (`..`, `/`) BEFORE
 * any `join`, instead of re-deriving a looser regex locally.
 */
export const AGENT_ID_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,79}$/

/**
 * AIP-42 reference implementation of `defineAgent`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "defineAgent (AIP-42): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * `./schema.ts` against the input. Same source of truth as the .md
 * path uses (`parseAgentManifest`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in `validate(def)` after the zod check.
 */
export const defineAgent = createDoctype<AgentDefinition, AgentHandle>({
  aip: 42,
  name: "agent",
  // AIP-42 ids accept an optional `@<owner>/` prefix for namespacing
  // across registries (e.g. `@agentik/writer`). Bare ids stay valid.
  idPattern: AGENT_ID_PATTERN,
  validate(def) {
    const result = agentFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineAgent (AIP-42): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
    // Extends-chain depth (≤5) and cycle checks require loading parent
    // manifests and are therefore async. Call `validateExtendsChain`
    // (exported from this package) in any context with file/registry
    // access before running the agent. Other cross-field rules (e.g.
    // autonomy=gated patterns from @agentproto/operator) go here.
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as AgentHandle
  },
})
