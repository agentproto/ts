/**
 * AIP-34 WorkspaceDefinition + WorkspaceHandle — the canonical `workspace/v2`
 * shape (see AIP-34 §Migrating from workspace/v1).
 *
 * Derived directly from `workspaceFrontmatterSchema` via `z.input` /
 * `z.output` rather than hand-maintained in parallel — one schema drives
 * both validation and the TS type, so they can't drift from each other.
 *
 * `WorkspaceDefinition` (input) accepts the pre-default shape an author
 * writes (defaults like `wall: "isolated"` are optional on input).
 * `WorkspaceHandle` (output) is the readonly, defaulted shape
 * `defineWorkspace`/`workspaceFromManifest` return.
 */

import type { z } from "zod"
import type { workspaceFrontmatterSchema } from "./schema.js"

export type WorkspaceDefinition = z.input<typeof workspaceFrontmatterSchema>
export type WorkspaceHandle = Readonly<z.output<typeof workspaceFrontmatterSchema>>
