/**
 * AIP-14 doctype spec — fed to `@agentproto/manifest.createVerbs`
 * to derive create / load / list / update / resolve / delete in one
 * place. Keeping the spec separate from `define-tool.ts` lets the
 * manifest layer (and the future MCP server) iterate over a uniform
 * descriptor without each package re-implementing the wiring.
 */

import { createVerbs, type DoctypeSpec } from "@agentproto/manifest"
import { defineTool } from "./define-tool.js"
import { parseToolManifest } from "./manifest/index.js"
import type { ToolDefinition, ToolHandle } from "./types.js"

export const toolSpec: DoctypeSpec<
  ToolDefinition<unknown, unknown>,
  ToolHandle<unknown, unknown>
> = {
  name: "tool",
  aip: 14,
  schemaLiteral: "agentproto/tool/v1",
  pathOf: (h) => `${h.id}/TOOL.md`,
  define: (params) =>
    defineTool(params) as ToolHandle<unknown, unknown>,
  parse: (source) => {
    const m = parseToolManifest(source)
    return {
      frontmatter: m.frontmatter as unknown as Record<string, unknown>,
      body: m.body,
    }
  },
}

export const toolVerbs = createVerbs(toolSpec)
