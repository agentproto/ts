/**
 * AIP-34 WorkspaceDefinitionV2 + WorkspaceHandleV2.
 *
 * Unlike v1's `types.ts` (a hand-maintained interface generated once
 * from JSON Schema, kept in sync by hand), these are DERIVED directly
 * from `workspaceV2FrontmatterSchema` via `z.input` / `z.output`. One
 * schema drives validation AND the TS type — the exact drift v1 risks
 * (and the repo's own spec-drift tooling exists to catch) can't happen
 * here because there's nothing to drift from.
 *
 * `WorkspaceDefinitionV2` (input) accepts the pre-default shape an
 * author writes (defaults like `wall: "isolated"` are optional on
 * input). `WorkspaceHandleV2` (output) is the readonly, defaulted
 * shape `defineWorkspaceV2`/`workspaceV2FromManifest` return.
 */

import type { z } from "zod"
import type { workspaceV2FrontmatterSchema } from "./schema-v2.js"

export type WorkspaceDefinitionV2 = z.input<typeof workspaceV2FrontmatterSchema>
export type WorkspaceHandleV2 = Readonly<z.output<typeof workspaceV2FrontmatterSchema>>
