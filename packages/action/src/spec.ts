/**
 * AIP-39 doctype spec — fed to `@agentproto/manifest.createVerbs`
 * to derive create / load / list / update / resolve / delete in one
 * place. Plugs into `@agentproto/mcp-server` so an action library
 * lives at `<workspace>/.actions/<id>/ACTION.md` (the convention
 * AIP-39's standard library uses) and is callable over MCP.
 */

import { createVerbs, type DoctypeSpec } from "@agentproto/manifest"
import { defineAction } from "./define-action.js"
import { parseActionManifest } from "./manifest/index.js"
import type { ActionDefinition, ActionHandle } from "./types.js"

export const actionSpec: DoctypeSpec<ActionDefinition, ActionHandle> = {
  name: "action",
  aip: 39,
  schemaLiteral: "action/v1",
  // Path convention: actions live under a `.actions/` dir keyed by
  // their kebab-cased id. AIP-39's standard library follows the same
  // shape (`.actions/secrets-reveal/ACTION.md` for id `secrets:reveal`).
  pathOf: (h) => {
    const slug = h.id.replace(/:/g, "-")
    return `.actions/${slug}/ACTION.md`
  },
  define: defineAction,
  parse: (source) => {
    const m = parseActionManifest(source)
    return {
      frontmatter: m.frontmatter as unknown as Record<string, unknown>,
      body: m.body,
    }
  },
}

export const actionVerbs = createVerbs(actionSpec)
