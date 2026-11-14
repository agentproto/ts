import { createDoctype } from "@agentproto/doctype"
import { workspaceFrontmatterSchema } from "./schema.js"
import type { WorkspaceDefinition, WorkspaceHandle } from "./types.js"

/**
 * AIP-34 reference implementation of `defineWorkspace` — `workspace/v2`,
 * the canonical and only schema this AIP defines (see AIP-34 §Migrating
 * from workspace/v1).
 *
 * Same `createDoctype` prologue as every other AIP defineX (id pattern,
 * description length via `readDescription: (def) => def.name`, canonical
 * error prefix, top-level freeze). Field-level validation runs
 * `workspaceFrontmatterSchema` — the ONE schema also used by the .md
 * manifest path (`manifest/index.ts`) and the exporter
 * (`writeWorkspaceManifest`) — so a malformed TS-authored definition, a
 * malformed manifest, and an attempted export of an invalid handle all
 * fail with the same diagnostic.
 *
 * Cross-node rules (type↔TYPES.md, includes↔exports consent, apps↔
 * accepted_apps consent, budget aggregation) are NOT checked here — a
 * single WORKSPACE.md can't see its neighbours. Those run in
 * `checker/check-tree.ts` against a whole materialized tree.
 */
export const defineWorkspace = createDoctype<WorkspaceDefinition, WorkspaceHandle>({
  aip: 34,
  name: "workspace",
  idPattern: /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/,
  readDescription: (def) => def.name,
  validate(def) {
    const result = workspaceFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineWorkspace (AIP-34): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
  },
  build(def) {
    const parsed = workspaceFrontmatterSchema.parse(def)
    return parsed as WorkspaceHandle
  },
})
