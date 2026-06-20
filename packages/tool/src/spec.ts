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
    const fm = m.frontmatter
    // `createVerbs.load` feeds this frontmatter straight to `define`
    // (= `defineTool`), which reads camelCase keys. The manifest uses
    // snake_case for multi-word fields, so they must be renamed here or
    // `defineTool` silently falls back to its defaults. Single-word fields
    // (mutates, approval, idempotent, tags, metadata, requires) share the
    // same key in both conventions and pass through unchanged.
    const frontmatter: Record<string, unknown> = {
      id: fm.id,
      name: fm.name,
      description: fm.description,
      version: fm.version,
      ...(fm.mutates !== undefined && { mutates: fm.mutates }),
      ...(fm.requires !== undefined && { requires: fm.requires }),
      ...(fm.approval !== undefined && { approval: fm.approval }),
      ...(fm.risk_level !== undefined && { riskLevel: fm.risk_level }),
      ...(fm.cost_class !== undefined && { costClass: fm.cost_class }),
      ...(fm.timeout_ms !== undefined && { timeoutMs: fm.timeout_ms }),
      ...(fm.idempotent !== undefined && { idempotent: fm.idempotent }),
      ...(fm.tags !== undefined && { tags: fm.tags }),
      ...(fm.metadata !== undefined && { metadata: fm.metadata }),
      // AIP-16 IO blocks pass through under the same keys.
      ...(fm.inputs !== undefined && { inputs: fm.inputs }),
      ...(fm.outputs !== undefined && { outputs: fm.outputs }),
    }
    return { frontmatter, body: m.body }
  },
}

export const toolVerbs = createVerbs(toolSpec)
