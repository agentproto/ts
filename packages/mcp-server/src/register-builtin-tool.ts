/**
 * registerBuiltinTool — one-call registration for the daemon's single-
 * implementation builtin tools, collapsing the defineTool + implementTool +
 * defineDriver + toMcpTool boilerplate that every migrated call site in
 * `@agentproto/runtime` previously repeated verbatim.
 *
 * Hardcodes the shared `agentproto-runtime-builtin` driver convention
 * (id/name/description) that all migrated sites used: one contract, one
 * body, no resolver routing — a convenience wrapper over {@link toMcpTool},
 * not a new mechanism.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ZodType } from "zod"
import { defineDriver, implementTool } from "@agentproto/driver"
import { defineTool, type ToolContext, type ToolTransformer } from "@agentproto/tool"
import { toMcpTool } from "./to-mcp-tool.js"

export interface RegisterBuiltinToolOptions<TInput, TOutput> {
  /** The AIP-14 tool id (also the default MCP tool name, `:`/`.`→`_`). */
  id: string
  /** The AIP-14 contract description, advertised over MCP verbatim. */
  description: string
  /** The zod input schema; object schemas become the MCP parameters directly. */
  inputSchema: ZodType<TInput>
  /** The tool body — receives the validated input only (no context). */
  handler: (input: TInput) => Promise<TOutput> | TOutput
  /**
   * Cross-cutting concerns applied at registration (e.g. `catchErrors()`,
   * `paginated()`), composed left-to-right in declared order.
   */
  transformers?: readonly ToolTransformer[]
}

/** Shared driver convention hardcoded across every daemon builtin tool. */
const BUILTIN_DRIVER = {
  id: "agentproto-runtime-builtin",
  name: "agentproto runtime builtin",
  description:
    "Single-implementation builtin driver for daemon tools migrated " +
    "onto the AIP contract layer.",
} as const

export function registerBuiltinTool<TInput, TOutput>(
  server: McpServer,
  opts: RegisterBuiltinToolOptions<TInput, TOutput>,
): void {
  const tool = defineTool<TInput, TOutput, ToolContext>({
    id: opts.id,
    description: opts.description,
    inputSchema: opts.inputSchema,
  })
  const impl = implementTool(tool, ({ input }) => opts.handler(input))
  const driver = defineDriver({
    ...BUILTIN_DRIVER,
    kind: "builtin",
    implements: [{ tool: tool.id, version: "*" }],
    implementations: [impl],
  })
  toMcpTool(server, {
    tool,
    candidates: [driver],
    transformers: opts.transformers,
  })
}
