import { createDoctype } from "@agentproto/define-doctype"
import { workspaceV2FrontmatterSchema } from "./schema-v2.js"
import type { WorkspaceDefinitionV2, WorkspaceHandleV2 } from "./types-v2.js"

/**
 * AIP-34 reference implementation of `defineWorkspace` for the
 * `workspace/v2` (tree node) schema. Additive sibling of
 * `defineWorkspace` (v1) — does not replace it; a v1-authored
 * WORKSPACE.md keeps using `defineWorkspace`.
 *
 * Same `createDoctype` prologue as every other AIP defineX (id
 * pattern, description length via `readDescription: (def) => def.name`,
 * canonical error prefix, top-level freeze). Field-level validation
 * runs `workspaceV2FrontmatterSchema` — the ONE schema also used by
 * the .md manifest path (`manifest/v2.ts`) and the exporter
 * (`manifest/v2.ts` `writeWorkspaceV2Manifest`) — so a malformed
 * TS-authored definition, a malformed manifest, and an attempted
 * export of an invalid handle all fail with the same diagnostic.
 *
 * Cross-node rules (type↔TYPES.md, includes↔exports consent, budget
 * aggregation) are NOT checked here — a single WORKSPACE.md can't see
 * its neighbours. Those run in `checker/check-tree.ts` against a whole
 * materialized tree.
 */
export const defineWorkspaceV2 = createDoctype<WorkspaceDefinitionV2, WorkspaceHandleV2>({
  aip: 34,
  name: "workspace",
  idPattern: /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/,
  readDescription: (def) => def.name,
  validate(def) {
    const result = workspaceV2FrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineWorkspace (AIP-34 workspace/v2): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
  },
  build(def) {
    const parsed = workspaceV2FrontmatterSchema.parse(def)
    return parsed as WorkspaceHandleV2
  },
})
