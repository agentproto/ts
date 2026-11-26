/**
 * AIP-14 doctype spec — fed to `@agentproto/manifest.createVerbs`
 * to derive create / load / list / update / resolve / delete in one
 * place. Keeping the spec separate from `define-tool.ts` lets the
 * manifest layer (and the future MCP server) iterate over a uniform
 * descriptor without each package re-implementing the wiring.
 */

import { createVerbs, type DoctypeSpec } from "@agentproto/manifest"
import { z, type ZodType } from "zod"
import { defineTool } from "./define-tool.js"
import { parseToolManifest } from "./manifest/index.js"
import type { ToolDefinition, ToolHandle } from "./types.js"

function zodToPlainJsonSchema(schema: ZodType<unknown>): Record<string, unknown> {
  const raw = z.toJSONSchema(schema) as Record<string, unknown>
  const { $schema: _ignored, ...rest } = raw
  return rest
}

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
  toFrontmatter: (params) => {
    const fm: Record<string, unknown> = {
      schema: "agentproto/tool/v1",
      id: params.id,
      name: params.name ?? params.id,
      description: params.description,
      version: params.version ?? "1.0.0",
    }
    const inputs =
      params.inputs !== undefined
        ? params.inputs
        : params.inputSchema !== undefined
          ? zodToPlainJsonSchema(params.inputSchema)
          : undefined
    const outputs =
      params.outputs !== undefined
        ? params.outputs
        : params.outputSchema !== undefined
          ? zodToPlainJsonSchema(params.outputSchema)
          : undefined
    if (inputs !== undefined) fm.inputs = inputs
    if (outputs !== undefined) fm.outputs = outputs
    if (params.mutates !== undefined) fm.mutates = [...params.mutates]
    if (params.requires !== undefined) {
      const req: Record<string, unknown> = {}
      if (params.requires.network !== undefined) req.network = [...params.requires.network]
      if (params.requires.secrets !== undefined) req.secrets = [...params.requires.secrets]
      if (params.requires.tools !== undefined) req.tools = [...params.requires.tools]
      if (Object.keys(req).length > 0) fm.requires = req
    }
    if (params.approval !== undefined) fm.approval = params.approval
    if (params.riskLevel !== undefined) fm.risk_level = params.riskLevel
    if (params.costClass !== undefined) fm.cost_class = params.costClass
    if (params.timeoutMs !== undefined) fm.timeout_ms = params.timeoutMs
    if (params.idempotent !== undefined) fm.idempotent = params.idempotent
    if (params.tags !== undefined) fm.tags = [...params.tags]
    if (params.metadata !== undefined && Object.keys(params.metadata).length > 0) {
      fm.metadata = { ...params.metadata }
    }
    return fm
  },
}

export const toolVerbs = createVerbs(toolSpec)
